import type { SqliteDatabase } from '../store/sqlite.js'
import { immediate } from '../store/sqlite.js'
import type { CatscoMessageReceipt, EffectAdapterRegistry } from '../adapters/catsco.js'
import { canonicalize } from '../lib/canonical-json.js'
import { digestJson } from '../lib/digest.js'
import { wakeAgentContent, wakeAgentPostcondition, type WakeAgentEffect } from '../protocol/effects.js'

export interface OutboxProviders { now(): string; token(): string }
const defaults: OutboxProviders = { now: () => new Date().toISOString(), token: () => crypto.randomUUID() }
class ObsoleteEffect extends Error {}
class ReceiptConflict extends Error {}

function validateReceipt(
  receipt: CatscoMessageReceipt,
  clientMsgId: string,
  contentDigest: string,
  requireServerConfirmation: boolean
): CatscoMessageReceipt | null {
  if (receipt.clientMsgId !== clientMsgId) {
    throw new ReceiptConflict(`CatsCo receipt conflict: client message id ${receipt.clientMsgId} does not match ${clientMsgId}`)
  }
  if (receipt.contentDigest !== contentDigest) {
    throw new ReceiptConflict(`CatsCo receipt conflict: content digest ${receipt.contentDigest ?? '<missing>'} does not match ${contentDigest}`)
  }
  if (requireServerConfirmation && receipt.serverConfirmed !== true) return null
  return receipt
}

function satisfy(db: SqliteDatabase, ownerUid: string, row: Record<string, unknown>, receipt: CatscoMessageReceipt, now: string): void {
  immediate(db, () => {
    db.prepare(`INSERT OR IGNORE INTO effect_receipts(
      owner_uid,effect_key,outbox_id,outcome,external_id,request_digest,response_digest,receipt_json,recorded_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      ownerUid, row.effect_key, row.outbox_id, 'satisfied', receipt.messageId,
      digestJson(JSON.parse(String(row.payload_json))), digestJson(receipt), canonicalize(receipt), now
    )
    db.prepare(`UPDATE outbox SET state='satisfied',claim_token=NULL,claim_expires_at=NULL,
      satisfied_at=?,last_error=NULL WHERE owner_uid=? AND outbox_id=?`
    ).run(now, ownerUid, row.outbox_id)
    db.prepare(`UPDATE actions SET state='satisfied' WHERE owner_uid=? AND action_id=?
      AND state IN ('ready','claimed')`).run(ownerUid, row.action_id)
  })
}

function retry(db: SqliteDatabase, ownerUid: string, row: Record<string, unknown>, error: unknown, now: string): void {
  const seconds = Math.min(300, 2 ** Math.min(8, Number(row.attempt_count)))
  const next = new Date(Date.parse(now) + seconds * 1000).toISOString()
  db.prepare(`UPDATE outbox SET state='pending',claim_token=NULL,claim_expires_at=NULL,
    next_attempt_at=?,last_error=? WHERE owner_uid=? AND outbox_id=?`
  ).run(next, String(error instanceof Error ? error.message : error).slice(0, 1000), ownerUid, row.outbox_id)
}

function obsolete(db: SqliteDatabase, ownerUid: string, row: Record<string, unknown>, reason: string, now: string): void {
  immediate(db, () => {
    db.prepare(`UPDATE outbox SET state='obsolete',claim_token=NULL,claim_expires_at=NULL,
      satisfied_at=?,last_error=? WHERE owner_uid=? AND outbox_id=? AND state IN ('pending','claimed')`
    ).run(now, `obsolete: ${reason}`.slice(0, 1000), ownerUid, row.outbox_id)
    db.prepare(`UPDATE actions SET state='cancelled' WHERE owner_uid=? AND action_id=?
      AND state IN ('ready','claimed')`).run(ownerUid, row.action_id)
  })
}

function assertCurrentAction(db: SqliteDatabase, ownerUid: string, row: Record<string, unknown>): void {
  const action = db.prepare(`SELECT a.kind,w.state FROM actions a
    JOIN work_items w ON w.owner_uid=a.owner_uid AND w.work_item_id=a.work_item_id
    WHERE a.owner_uid=? AND a.action_id=? AND a.state='ready'
      AND a.work_item_revision=? AND a.target_digest=? AND w.revision=a.work_item_revision
      AND ((a.kind='execute_attempt' AND w.state='assigned')
        OR (a.kind='review_candidate' AND w.state='candidate')
        OR (a.kind='plan_next' AND w.state IN ('accepted','closed')))`
  ).get(ownerUid, row.action_id, row.action_work_item_revision, row.action_target_digest)
  if (!action) throw new ObsoleteEffect('Action no longer matches current Work Item revision/state')
}

export async function runOutbox(
  db: SqliteDatabase,
  ownerUid: string,
  registry: EffectAdapterRegistry,
  maxEffects = 100,
  providers: OutboxProviders = defaults
): Promise<{ satisfied: number; retried: number; obsolete: number; ownerMismatch: boolean }> {
  let satisfiedCount = 0
  let retried = 0
  let obsoleteCount = 0
  let ownerMismatch = false
  for (let i = 0; i < maxEffects; i++) {
    const now = providers.now()
    const token = providers.token()
    const row = immediate(db, () => {
      const found = db.prepare(`SELECT * FROM outbox WHERE owner_uid=? AND
        ((state='pending' AND next_attempt_at<=?) OR (state='claimed' AND claim_expires_at<=?))
        ORDER BY created_at LIMIT 1`).get(ownerUid, now, now) as Record<string, unknown> | undefined
      if (!found) return undefined
      const expires = new Date(Date.parse(now) + 30_000).toISOString()
      db.prepare(`UPDATE outbox SET state='claimed',claim_token=?,claim_expires_at=?,
        attempt_count=attempt_count+1 WHERE owner_uid=? AND outbox_id=?`
      ).run(token, expires, ownerUid, found.outbox_id)
      return db.prepare('SELECT * FROM outbox WHERE owner_uid=? AND outbox_id=?')
        .get(ownerUid, found.outbox_id) as Record<string, unknown>
    })
    if (!row) break

    try {
      assertCurrentAction(db, ownerUid, row)
      if (row.adapter !== 'catsco') throw new Error(`unsupported effect adapter: ${String(row.adapter)}`)
      const adapter = registry.catsco
      const identity = await adapter.me()
      if (identity.uid !== ownerUid) {
        ownerMismatch = true
        throw new Error('CatsCo authenticated owner does not match outbox namespace')
      }
      const effect = JSON.parse(String(row.payload_json)) as WakeAgentEffect
      const content = wakeAgentContent(effect)
      const expected = wakeAgentPostcondition(ownerUid, effect)
      const stored = JSON.parse(String(row.postcondition_json)) as Partial<typeof expected>
      if (canonicalize(stored) !== canonicalize(expected)) {
        throw new ReceiptConflict('pending effect conflict: stored owner/topic/version postcondition does not match exact canonical payload')
      }

      const found = await adapter.findMessage(effect.targetTopicId, expected.clientMsgId)
      let receipt = found
        ? validateReceipt(found, expected.clientMsgId, expected.contentDigest, true)
        : null
      if (!receipt) {
        assertCurrentAction(db, ownerUid, row)
        try {
          const sent = await adapter.sendExistingTopic(effect.targetTopicId, content, expected.clientMsgId)
          receipt = validateReceipt(sent, expected.clientMsgId, expected.contentDigest, false)
        } catch (sendError) {
          const reconciled = await adapter.findMessage(effect.targetTopicId, expected.clientMsgId)
          receipt = reconciled
            ? validateReceipt(reconciled, expected.clientMsgId, expected.contentDigest, true)
            : null
          if (!receipt) throw sendError
        }
      }
      if (!receipt) throw new Error('CatsCo send produced no acknowledged receipt')
      satisfy(db, ownerUid, row, receipt, now)
      satisfiedCount++
    } catch (error) {
      if (error instanceof ObsoleteEffect) {
        obsolete(db, ownerUid, row, error.message, now)
        obsoleteCount++
      } else {
        retry(db, ownerUid, row, error, now)
        retried++
        if (ownerMismatch) break
      }
    }
  }
  return { satisfied: satisfiedCount, retried, obsolete: obsoleteCount, ownerMismatch }
}
