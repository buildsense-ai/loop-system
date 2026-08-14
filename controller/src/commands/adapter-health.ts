import { parseArgs } from 'node:util'
import { ZodError } from 'zod'
import { OpenCliCatscoAdapter } from '../adapters/catsco-opencli.js'
import type { CatscoAdapter, CatscoMessageReceipt, CatscoPollResult } from '../adapters/catsco.js'
import { loadConfig, type LoopConfig } from '../config.js'
import { ProcessFailure } from '../lib/process.js'

const output = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export type AdapterHealthClassification =
  | 'healthy'
  | 'owner_mismatch'
  | 'opencli_timeout'
  | 'opencli_navigation_rejected'
  | 'opencli_auth_required'
  | 'opencli_command_failed'
  | 'opencli_malformed_output'
  | 'opencli_error'
  | 'poll_unavailable'
  | 'receipt_unavailable'
  | 'poll_malformed_result'
  | 'receipt_malformed_result'

export type AdapterHealthStageName = 'identity' | 'poll' | 'receipt'
export interface AdapterHealthStage {
  name: AdapterHealthStageName
  status: 'passed' | 'failed' | 'skipped'
  classification: AdapterHealthClassification
  detail: string
  observations?: number
  found?: boolean
}

export interface AdapterHealthReport {
  healthy: boolean
  classification: AdapterHealthClassification
  configuredOwnerUid: string
  activeOwnerUid?: string
  detail: string
  stages: AdapterHealthStage[]
}

type HealthAdapter = Pick<CatscoAdapter, 'me' | 'findMessage' | 'poll'>

function chain(error: unknown): unknown[] {
  const values: unknown[] = []
  let current = error
  while (current && typeof current === 'object' && !values.includes(current)) {
    values.push(current)
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined
  }
  return values
}

function detail(error: unknown): string {
  return chain(error).flatMap(value => {
    if (value instanceof ProcessFailure) return [value.message, value.result?.stderr ?? '']
    return [value instanceof Error ? value.message : String(value)]
  }).filter(Boolean).join(': ').slice(0, 4_000)
}

function classify(error: unknown): AdapterHealthClassification {
  const errors = chain(error)
  const message = detail(error).toLowerCase()
  if (message.includes('timed out')) return 'opencli_timeout'
  if (message.includes('navigation rejected')) return 'opencli_navigation_rejected'
  if (message.includes('requires a logged-in session') || message.includes('sign in')) return 'opencli_auth_required'
  if (errors.some(value => value instanceof ZodError || value instanceof SyntaxError)) return 'opencli_malformed_output'
  if (errors.some(value => value instanceof ProcessFailure)) return 'opencli_command_failed'
  return 'opencli_error'
}

function validPollResult(value: unknown): value is CatscoPollResult {
  if (!value || typeof value !== 'object' || !Array.isArray((value as CatscoPollResult).observations)) return false
  const result = value as CatscoPollResult
  if (result.nextCursor === null || result.nextCursor === undefined || String(result.nextCursor).trim() === '') return false
  return result.observations.every(observation => {
    const attestation = observation?.attestation
    return Boolean(observation && attestation && typeof attestation.topicId === 'string' && attestation.topicId.trim() &&
      typeof attestation.seqId === 'string' && attestation.seqId.trim() && typeof attestation.senderUid === 'string' && attestation.senderUid.trim() &&
      typeof attestation.serverReceivedAt === 'string' && Number.isFinite(Date.parse(attestation.serverReceivedAt)))
  })
}

function validReceipt(value: unknown): value is CatscoMessageReceipt {
  return Boolean(value) && typeof value === 'object' && typeof (value as CatscoMessageReceipt).messageId === 'string' &&
    (value as CatscoMessageReceipt).messageId.trim().length > 0 && typeof (value as CatscoMessageReceipt).clientMsgId === 'string' &&
    (value as CatscoMessageReceipt).clientMsgId.trim().length > 0 && typeof (value as CatscoMessageReceipt).duplicate === 'boolean'
}

function failed(name: AdapterHealthStageName, classification: AdapterHealthClassification, error: unknown): AdapterHealthStage {
  return { name, status: 'failed', classification, detail: detail(error) }
}

async function pollStage(config: LoopConfig, catsco: HealthAdapter): Promise<AdapterHealthStage> {
  if (!config.healthPollTopicId) return { name: 'poll', status: 'skipped', classification: 'healthy', detail: 'no health poll topic configured' }
  if (!catsco.poll) return { name: 'poll', status: 'failed', classification: 'poll_unavailable', detail: 'CatsCo adapter does not support read-only polling' }
  try {
    const result = await catsco.poll(config.healthPollTopicId, String(config.healthPollAfterSeq ?? 0))
    if (!validPollResult(result)) return { name: 'poll', status: 'failed', classification: 'poll_malformed_result', detail: 'CatsCo poll returned an invalid result envelope' }
    return { name: 'poll', status: 'passed', classification: 'healthy', detail: `read-only poll succeeded for ${config.healthPollTopicId}`, observations: result.observations.length }
  } catch (error) {
    return failed('poll', classify(error), error)
  }
}

async function receiptStage(config: LoopConfig, catsco: HealthAdapter): Promise<AdapterHealthStage> {
  if (!config.healthReceiptTopicId || !config.healthReceiptClientMsgId) return { name: 'receipt', status: 'skipped', classification: 'healthy', detail: 'no health receipt lookup configured' }
  try {
    const receipt = await catsco.findMessage(config.healthReceiptTopicId, config.healthReceiptClientMsgId)
    if (receipt !== null && !validReceipt(receipt)) return { name: 'receipt', status: 'failed', classification: 'receipt_malformed_result', detail: 'CatsCo receipt lookup returned an invalid receipt' }
    return { name: 'receipt', status: 'passed', classification: 'healthy', detail: `read-only receipt lookup succeeded for ${config.healthReceiptTopicId}`, found: receipt !== null }
  } catch (error) {
    return failed('receipt', classify(error), error)
  }
}

export async function adapterHealthReport(config: LoopConfig, catsco: HealthAdapter): Promise<AdapterHealthReport> {
  const stages: AdapterHealthStage[] = []
  let activeOwnerUid: string | undefined
  try {
    const { uid } = await catsco.me()
    activeOwnerUid = uid
    if (uid !== config.ownerUid) {
      const stage = { name: 'identity', status: 'failed', classification: 'owner_mismatch', detail: `configured owner ${config.ownerUid} does not match authenticated CatsCo owner ${uid}` } as const
      stages.push(stage)
      return { healthy: false, classification: stage.classification, configuredOwnerUid: config.ownerUid, activeOwnerUid, detail: stage.detail, stages }
    }
    stages.push({ name: 'identity', status: 'passed', classification: 'healthy', detail: `authenticated CatsCo owner ${uid} matches configured namespace` })
  } catch (error) {
    const stage = failed('identity', classify(error), error)
    stages.push(stage)
    return { healthy: false, classification: stage.classification, configuredOwnerUid: config.ownerUid, detail: stage.detail, stages }
  }

  stages.push(await pollStage(config, catsco))
  stages.push(await receiptStage(config, catsco))
  const failure = stages.find(stage => stage.status === 'failed')
  return {
    healthy: !failure,
    classification: failure?.classification ?? 'healthy',
    configuredOwnerUid: config.ownerUid,
    ...(activeOwnerUid ? { activeOwnerUid } : {}),
    detail: failure?.detail ?? `all configured read-only OpenCLI adapter checks passed for owner ${activeOwnerUid}`,
    stages
  }
}

/** Read-only transport guard for service units before any semantic Controller command. */
export async function adapterHealthCommand(args: string[]): Promise<void> {
  parseArgs({ args, strict: true })
  const config = await loadConfig()
  const report = await adapterHealthReport(config, new OpenCliCatscoAdapter(config.opencliCommand))
  output(report)
  if (!report.healthy) process.exitCode = 1
}
