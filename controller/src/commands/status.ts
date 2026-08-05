import { parseArgs } from 'node:util'
import { context, output } from './common.js'
import { statusRows } from '../store/repositories.js'
import { capabilities } from '../protocol/effects.js'

export async function statusCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      'work-item': { type: 'string' },
      'include-outbox': { type: 'boolean' },
      json: { type: 'boolean' }
    },
    strict: true
  })
  const { config, db } = await context()
  try {
    const status = { ...statusRows(db, config.ownerUid), capabilities }
    if (values['work-item']) {
      const belongs = (item: unknown) => (item as Record<string, unknown>).workItemId === values['work-item']
      status.workItems = status.workItems.filter(belongs)
      status.attempts = status.attempts.filter(belongs)
      status.candidates = status.candidates.filter(belongs)
      status.actions = status.actions.filter(belongs)
    }
    const result: Record<string, unknown> = { ...status }
    if (values['include-outbox']) {
      result.outboxRows = db.prepare(`SELECT outbox_id outboxId,effect_key effectKey,effect_type effectType,
        state,attempt_count attemptCount,next_attempt_at nextAttemptAt,last_error lastError
        FROM outbox WHERE owner_uid=? ORDER BY created_at`).all(config.ownerUid)
    }
    output(result)
  } finally {
    db.close()
  }
}
