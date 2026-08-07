import { parseArgs } from 'node:util'
import { loadConfig } from '../config.js'
import { runProcess } from '../lib/process.js'
import { currentConfig, output } from './common.js'

export async function doctorCommand(args: string[]) {
  parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true })
  const configured = await loadConfig()
  let config = configured
  let catscoRead = 'unavailable'
  let catscoDetail = ''
  let githubRead = 'unavailable'
  let githubDetail = ''
  try {
    config = await currentConfig()
    catscoRead = 'available'
    catscoDetail = `authenticated owner resolved dynamically: ${config.ownerUid}`
  } catch (error) {
    catscoDetail = error instanceof Error ? error.message : String(error)
  }
  try {
    await runProcess(config.ghCommand, ['auth', 'status'])
    githubRead = 'available'
    githubDetail = 'ambient gh authentication available'
  } catch (error) {
    githubDetail = error instanceof Error ? error.message : String(error)
  }
  output({
    catscoRead, catscoExistingTopicSend: catscoRead, catscoBoundedPolling: catscoRead, catscoDetail,
    catscoSendDetail: 'idempotent existing-topic send; reconciliation uses this machine local registry plus server seq confirmation',
    catscoPollingDetail: 'limit 200; bounded topics and a single controller host only; overflow fails closed',
    githubRead, githubDetail, configuredOwnerUid: configured.ownerUid, ownerUid: config.ownerUid, automaticTaskCreation: 'blocked',
    runtimeWrapper: 'not_controller_managed',
    reviewerBridge: 'not_controller_managed',
    artifactWrite: 'not_controller_managed',
    runtimeWrapperDetail: 'Controller dispatches existing CatsCo Topics; Worker Runtime owns session creation and execution.',
    reviewerBridgeDetail: 'Review User receives existing CatsCo messages directly; Controller only sends durable Action packets.',
    artifactWriteDetail: 'Candidate/PR evidence is written by the Worker and verified through GitHub readback; Controller does not write CatsCo Artifacts.',
    dispatchReadiness: catscoRead === 'available' ? 'ready_for_existing_catsco_runtime' : 'blocked_by_catsco_auth'
  })
}
