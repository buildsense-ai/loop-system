import { parseArgs } from 'node:util'
import { ZodError } from 'zod'
import { OpenCliCatscoAdapter } from '../adapters/catsco-opencli.js'
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

export interface AdapterHealthReport {
  healthy: boolean
  classification: AdapterHealthClassification
  configuredOwnerUid: string
  activeOwnerUid?: string
  detail: string
}

type OwnerReader = Pick<OpenCliCatscoAdapter, 'me'>

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

export async function adapterHealthReport(config: LoopConfig, catsco: OwnerReader): Promise<AdapterHealthReport> {
  try {
    const { uid } = await catsco.me()
    if (uid !== config.ownerUid) {
      return {
        healthy: false,
        classification: 'owner_mismatch',
        configuredOwnerUid: config.ownerUid,
        activeOwnerUid: uid,
        detail: `configured owner ${config.ownerUid} does not match authenticated CatsCo owner ${uid}`
      }
    }
    return {
      healthy: true,
      classification: 'healthy',
      configuredOwnerUid: config.ownerUid,
      activeOwnerUid: uid,
      detail: `authenticated CatsCo owner ${uid} matches configured namespace`
    }
  } catch (error) {
    return {
      healthy: false,
      classification: classify(error),
      configuredOwnerUid: config.ownerUid,
      detail: detail(error)
    }
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
