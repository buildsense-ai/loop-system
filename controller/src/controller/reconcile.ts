import type { SqliteDatabase } from '../store/sqlite.js'
import type { CatscoAdapter, CatscoMessageAttestation } from '../adapters/catsco.js'
import { defaultProviders, ingest, type Providers } from './ingest.js'
import { canonicalize } from '../lib/canonical-json.js'
import { ingressEventSchema, type IngressEvent } from '../protocol/events.js'

export async function reconcile(
  db: SqliteDatabase,
  ownerUid: string,
  adapter: CatscoAdapter,
  providers?: Providers,
  workItemId?: string,
  options: { runtimeStartTimeoutMs?: number; topicScope?: 'all' | 'worker' } = {}
) {
  const effectiveProviders = providers ?? defaultProviders
  if (!adapter.poll) {
    return { status: 'unavailable', reason: 'CatsCo polling is not implemented by this adapter; no cursor advanced', observations: 0 }
  }
  const identity = await adapter.me()
  if (identity.uid !== ownerUid) {
    throw new Error('CatsCo authenticated owner does not match reconciliation namespace; no poll or cursor advance occurred')
  }
  const sql = `SELECT worker_topic_id,steward_topic_id FROM work_items
    WHERE owner_uid=? AND state NOT IN ('accepted','closed') ${workItemId ? 'AND work_item_id=?' : ''}`
  const params = workItemId ? [ownerUid, workItemId] : [ownerUid]
  const items = db.prepare(sql).all(...params) as { worker_topic_id: string; steward_topic_id: string }[]
  const topics = [...new Set(items.flatMap(item => options.topicScope === 'worker'
    ? [item.worker_topic_id]
    : [item.worker_topic_id, item.steward_topic_id]))]
  const polled: { topicId: string; observations: { event: IngressEvent; attestation: CatscoMessageAttestation }[]; nextCursor: unknown }[] = []
  for (const topicId of topics) {
    const cursorRow = db.prepare(
      `SELECT cursor_json FROM source_cursors WHERE owner_uid=? AND source='catsco' AND scope_key=?`
    ).get(ownerUid, topicId) as { cursor_json: string } | undefined
    const cursor = cursorRow ? JSON.parse(cursorRow.cursor_json) : null
    const result = await adapter.poll(topicId, cursor)
    const observations: typeof polled[number]['observations'] = []
    for (const observation of result.observations) {
      const attestation = observation.attestation
      if (attestation.topicId !== topicId) {
        throw new Error('CatsCo observation topic does not match the polled topic; cursor was not advanced')
      }
      if (!attestation.senderUid || !attestation.seqId || !Number.isFinite(Date.parse(attestation.serverReceivedAt))) {
        throw new Error('CatsCo observation is missing trusted envelope fields; cursor was not advanced')
      }
      const event = ingressEventSchema.safeParse(observation.event)
      if (!event.success || (event.data.type !== 'candidate_submitted' && event.data.type !== 'review_decided' && event.data.type !== 'runtime_started')) continue
      observations.push({ event: event.data, attestation })
    }
    polled.push({ topicId, observations, nextCursor: result.nextCursor })
  }

  let observations = 0
  for (const batch of polled) {
    for (const observation of batch.observations) {
      ingest(db, ownerUid, observation.event, effectiveProviders, observation.attestation)
      observations++
    }
  }
  for (const batch of polled) {
    db.prepare(`INSERT INTO source_cursors(owner_uid,source,scope_key,cursor_json,updated_at)
      VALUES(?,'catsco',?,?,?)
      ON CONFLICT(owner_uid,source,scope_key) DO UPDATE SET
        cursor_json=excluded.cursor_json,updated_at=excluded.updated_at`
    ).run(ownerUid, batch.topicId, canonicalize(batch.nextCursor), effectiveProviders.now())
  }

  const runtimeStartTimeoutMs = options.runtimeStartTimeoutMs ?? Number(process.env.LOOPCTL_RUNTIME_START_TIMEOUT_MS ?? 90_000)
  if (!Number.isFinite(runtimeStartTimeoutMs) || runtimeStartTimeoutMs < 1_000) {
    throw new Error('LOOPCTL_RUNTIME_START_TIMEOUT_MS must be at least 1000 milliseconds')
  }
  const now = Date.parse(effectiveProviders.now())
  const watchdogRows = db.prepare(`SELECT a.attempt_id attemptId,a.work_item_id workItemId,
      er.recorded_at recordedAt
    FROM attempts a
    JOIN actions action ON action.owner_uid=a.owner_uid
      AND action.work_item_id=a.work_item_id
      AND action.work_item_revision=a.work_item_revision
      AND action.kind='execute_attempt'
      AND action.state='satisfied'
    JOIN outbox o ON o.owner_uid=action.owner_uid AND o.action_id=action.action_id
    JOIN effect_receipts er ON er.owner_uid=o.owner_uid AND er.effect_key=o.effect_key
    WHERE a.owner_uid=? AND a.control_state='allocated' AND a.reported_state='unknown'
      AND (? IS NULL OR a.work_item_id=?)`).all(ownerUid, workItemId ?? null, workItemId ?? null) as {
        attemptId: string; workItemId: string; recordedAt: string
      }[]
  let bridgeUnavailable = 0
  for (const row of watchdogRows) {
    if (now - Date.parse(row.recordedAt) < runtimeStartTimeoutMs) continue
    const receipt = ingest(db, ownerUid, {
      type: 'runtime_progress_observed',
      eventId: `runtime-bridge-unavailable:${row.attemptId}`,
      idempotencyKey: `runtime-bridge-unavailable:${row.attemptId}`,
      source: 'loopctl-watchdog',
      entityRef: `attempt:${row.attemptId}`,
      payload: { workItemId: row.workItemId, attemptId: row.attemptId, reportedState: 'runtime_bridge_unavailable' }
    }, effectiveProviders)
    if (receipt.status === 'pending' || receipt.status === 'committed') bridgeUnavailable++
  }
  return { status: 'enqueued', observations, bridgeUnavailable }
}
