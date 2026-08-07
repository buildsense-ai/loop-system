import { parseArgs } from 'node:util'
import { context, output } from './common.js'
import { ingest } from '../controller/ingest.js'
import { tick } from '../controller/tick.js'
import { Ed25519RuntimeProofAdapter } from '../adapters/runtime-ed25519.js'
import { GhGitHubAdapter } from '../adapters/github-gh.js'
import { OpenCliCatscoAdapter } from '../adapters/catsco-opencli.js'
import { CatscoReviewerAuthorityAdapter, UnavailableReviewerAuthorityAdapter } from '../adapters/reviewer.js'
import { ExplicitRuntimeProofAdapter } from '../adapters/runtime-explicit.js'

export async function abandonCommand(args: string[]) {
  const { values } = parseArgs({ args, options: { 'work-item': { type: 'string' }, attempt: { type: 'string' }, 'expected-revision': { type: 'string' }, 'request-id': { type: 'string' } }, strict: true })
  const workItemId = String(values['work-item'] ?? '')
  const attemptId = String(values.attempt ?? '')
  const expectedRevision = Number(values['expected-revision'])
  const requestId = String(values['request-id'] ?? '').trim()
  if (!workItemId || !attemptId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !requestId) {
    throw new Error('abandon requires --work-item ID --attempt ID --expected-revision N --request-id ID')
  }
  const { config, db } = await context()
  try {
    const attempt = db.prepare(`SELECT generation FROM attempts WHERE owner_uid=? AND work_item_id=? AND attempt_id=?`)
      .get(config.ownerUid, workItemId, attemptId) as { generation: number } | undefined
    if (!attempt) throw new Error('attempt_not_found')
    const eventId = `attempt-abandoned:${attemptId}:${attempt.generation}:${requestId}`
    const receipt = ingest(db, config.ownerUid, {
      type: 'attempt_abandoned', eventId, idempotencyKey: eventId, source: 'loopctl', entityRef: `attempt:${attemptId}`,
      payload: { workItemId, expectedRevision, attemptId, generation: attempt.generation }
    })
    const result = await tick(db, config.ownerUid, {
      runtime: new ExplicitRuntimeProofAdapter(new Ed25519RuntimeProofAdapter()), github: new GhGitHubAdapter(config.ghCommand),
      reviewer: new CatscoReviewerAuthorityAdapter(new UnavailableReviewerAuthorityAdapter()), catsco: new OpenCliCatscoAdapter(config.opencliCommand)
    }, { maxEvents: 1, maxEffects: 0, effects: false })
    output({ receipt, tick: result })
  } finally { db.close() }
}
