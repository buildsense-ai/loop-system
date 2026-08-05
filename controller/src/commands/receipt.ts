import { parseArgs } from 'node:util'
import { context, output } from './common.js'

export async function receiptCommand(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } }, strict: true })
  if (!positionals[0]) throw new Error('receipt requires an idempotency key or conflict id')
  const { config, db } = await context()
  try {
    const inbox = db.prepare(`SELECT status,transition_receipt_json,rejection_code FROM inbox
      WHERE owner_uid=? AND idempotency_key=?`).get(config.ownerUid, positionals[0]) as Record<string, unknown> | undefined
    if (inbox) {
      output(inbox.transition_receipt_json ? JSON.parse(String(inbox.transition_receipt_json)) : {
        status: inbox.status, rejectionCode: inbox.rejection_code
      })
      return
    }
    const conflict = db.prepare(`SELECT transition_receipt_json FROM ingress_conflicts
      WHERE owner_uid=? AND conflict_id=?`).get(config.ownerUid, positionals[0]) as { transition_receipt_json: string } | undefined
    if (!conflict) throw new Error('receipt not found')
    output(JSON.parse(conflict.transition_receipt_json))
  } finally {
    db.close()
  }
}
