import type { SqliteDatabase } from '../store/sqlite.js'
import type { CatscoAdapter, CatscoMessageAttestation } from '../adapters/catsco.js'
import { ingest, type Providers } from './ingest.js'
import { canonicalize } from '../lib/canonical-json.js'
import { ingressEventSchema, type IngressEvent } from '../protocol/events.js'

export async function reconcile(
  db: SqliteDatabase,
  ownerUid: string,
  adapter: CatscoAdapter,
  providers?: Providers,
  workItemId?: string
) {
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
  const topics = [...new Set(items.flatMap(item => [item.worker_topic_id, item.steward_topic_id]))]
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
      ingest(db, ownerUid, observation.event, providers, observation.attestation)
      observations++
    }
  }
  for (const batch of polled) {
    db.prepare(`INSERT INTO source_cursors(owner_uid,source,scope_key,cursor_json,updated_at)
      VALUES(?,'catsco',?,?,?)
      ON CONFLICT(owner_uid,source,scope_key) DO UPDATE SET
        cursor_json=excluded.cursor_json,updated_at=excluded.updated_at`
    ).run(ownerUid, batch.topicId, canonicalize(batch.nextCursor), providers?.now() ?? new Date().toISOString())
  }
  return { status: 'enqueued', observations }
}
