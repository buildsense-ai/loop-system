import { parseArgs } from 'node:util'
import { loadConfig } from '../config.js'
import { OpenCliCatscoAdapter } from '../adapters/catsco-opencli.js'
import { runProcess } from '../lib/process.js'
import { output } from './common.js'

export async function doctorCommand(args: string[]) {
  parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true })
  const config = await loadConfig()
  let catscoRead = 'unavailable'
  let catscoDetail = ''
  let githubRead = 'unavailable'
  let githubDetail = ''
  try {
    const me = await new OpenCliCatscoAdapter(config.opencliCommand).me()
    catscoRead = me.uid === config.ownerUid ? 'available' : 'unavailable'
    catscoDetail = me.uid === config.ownerUid ? 'authenticated owner matches' : 'authenticated owner mismatch'
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
    githubRead, githubDetail, automaticTaskCreation: 'blocked',
    runtimeWrapper: 'unavailable', reviewerBridge: 'unavailable', artifactWrite: 'unavailable'
  })
}
