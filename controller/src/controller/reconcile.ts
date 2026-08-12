import type { SqliteDatabase } from '../store/sqlite.js'
import type { CatscoAdapter, CatscoMessageAttestation } from '../adapters/catsco.js'
import { defaultProviders, ingest, type Providers } from './ingest.js'
import { canonicalize } from '../lib/canonical-json.js'
import { ingressEventSchema, type IngressEvent } from '../protocol/events.js'
import type { TransitionReceipt } from '../protocol/receipts.js'
import { tick } from './tick.js'
import type { ProcessingAdapters } from './process-inbox.js'

export async function reconcile(
  db: SqliteDatabase,
  ownerUid: string,
  adapter: CatscoAdapter,
  providers?: Providers,
  workItemId?: string,
  options: {
    runtimeStartTimeoutMs?: number
    workerReadinessTimeoutMs?: number
    topicScope?: 'all' | 'worker'
    mode?: 'enqueue-only' | 'drive'
    processingAdapters?: ProcessingAdapters
    maxEvents?: number
    maxEffects?: number
  } = {}
) {
  const effectiveProviders = providers ?? defaultProviders
  const mode = options.mode ?? 'enqueue-only'
  if (mode === 'drive' && !options.processingAdapters) throw new Error('drive reconciliation requires processing adapters')
  if (!adapter.poll) {
    return { status: 'unavailable', mode, reason: 'CatsCo polling is not implemented by this adapter; no cursor advanced',
      observations: 0, enqueued: 0, ingested: [], cursors: [], bridgeUnavailable: 0, readinessTimedOut: 0, dispatchTimedOut: 0 }
  }
  const identity = await adapter.me()
  if (identity.uid !== ownerUid) {
    throw new Error('CatsCo authenticated owner does not match reconciliation namespace; no poll or cursor advance occurred')
  }
  const sql = `SELECT state,worker_topic_id,evidence_topic_id,steward_topic_id FROM work_items
    WHERE owner_uid=? AND state NOT IN ('accepted','closed') ${workItemId ? 'AND work_item_id=?' : ''}`
  const params = workItemId ? [ownerUid, workItemId] : [ownerUid]
  const items = db.prepare(sql).all(...params) as {
    state: string; worker_topic_id: string; evidence_topic_id: string; steward_topic_id: string
  }[]
  const topics = [...new Set(items.flatMap(item => {
    // Evidence-lane Attempts never poll Runtime or Review conversations: only the
    // quiet per-Attempt lane carries trusted lifecycle packets. Legacy rows retain
    // the former Worker/Steward fallback until they naturally finish.
    const evidenceTopicId = item.evidence_topic_id || undefined
    if (options.topicScope === 'worker') return [evidenceTopicId ?? item.worker_topic_id]
    if (item.state === 'ready') return []
    return evidenceTopicId ? [evidenceTopicId] : [item.worker_topic_id, item.steward_topic_id]
  }))]
  const polled: { topicId: string; cursor: unknown; observations: { event: IngressEvent; attestation: CatscoMessageAttestation }[]; nextCursor: unknown }[] = []
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
      if (!event.success || (event.data.type !== 'worker_ready' && event.data.type !== 'candidate_submitted' && event.data.type !== 'review_decided' && event.data.type !== 'runtime_started')) continue
      observations.push({ event: event.data, attestation })
    }
    polled.push({ topicId, cursor, observations, nextCursor: result.nextCursor })
  }

  let observations = 0
  const ingested: TransitionReceipt[] = []
  for (const batch of polled) {
    for (const observation of batch.observations) {
      ingested.push(ingest(db, ownerUid, observation.event, effectiveProviders, observation.attestation))
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
  const workerReadinessTimeoutMs = options.workerReadinessTimeoutMs ?? Number(process.env.LOOPCTL_WORKER_READINESS_TIMEOUT_MS ?? 90_000)
  if (!Number.isFinite(runtimeStartTimeoutMs) || runtimeStartTimeoutMs < 1_000) {
    throw new Error('LOOPCTL_RUNTIME_START_TIMEOUT_MS must be at least 1000 milliseconds')
  }
  if (!Number.isFinite(workerReadinessTimeoutMs) || workerReadinessTimeoutMs < 1_000) {
    throw new Error('LOOPCTL_WORKER_READINESS_TIMEOUT_MS must be at least 1000 milliseconds')
  }
  const now = Date.parse(effectiveProviders.now())
  const watchdogRows = db.prepare(`SELECT a.attempt_id attemptId,a.work_item_id workItemId,
      a.generation generation,w.revision workItemRevision,a.control_state controlState,action.kind actionKind,
      json_extract(er.receipt_json,'$.serverReceivedAt') serverReceivedAt,
      json_extract(er.receipt_json,'$.serverConfirmed') serverConfirmed
    FROM attempts a
    JOIN work_items w ON w.owner_uid=a.owner_uid AND w.work_item_id=a.work_item_id
    JOIN actions action ON action.owner_uid=a.owner_uid
      AND action.work_item_id=a.work_item_id
      AND action.work_item_revision=a.work_item_revision
      AND action.state='satisfied'
      AND ((a.control_state='preflight' AND action.kind='preflight_attempt')
        OR (a.control_state='allocated' AND action.kind='execute_attempt'))
    JOIN outbox o ON o.owner_uid=action.owner_uid AND o.action_id=action.action_id
    JOIN effect_receipts er ON er.owner_uid=o.owner_uid AND er.effect_key=o.effect_key
    WHERE a.owner_uid=? AND a.reported_state='unknown'
      AND (? IS NULL OR a.work_item_id=?)`).all(ownerUid, workItemId ?? null, workItemId ?? null) as {
        attemptId: string; workItemId: string; generation: number; workItemRevision: number;
        controlState: string; actionKind: string; serverReceivedAt: string | null; serverConfirmed: number | null
      }[]
  let readinessTimedOut = 0
  let dispatchTimedOut = 0
  for (const row of watchdogRows) {
    // Dispatch timers are safe only when the actual CatsCo server confirmed and
    // timestamped the Action. Older local-only receipts remain observable but are
    // deliberately not eligible for automatic supersession.
    if (row.serverConfirmed !== 1 || !row.serverReceivedAt || !Number.isFinite(Date.parse(row.serverReceivedAt))) continue
    const timeoutMs = row.actionKind === 'preflight_attempt' ? workerReadinessTimeoutMs : runtimeStartTimeoutMs
    if (now - Date.parse(row.serverReceivedAt) < timeoutMs) continue
    const timeoutType = row.actionKind === 'preflight_attempt' ? 'attempt_readiness_timed_out' : 'attempt_dispatch_timed_out'
    const receipt = ingest(db, ownerUid, {
      type: timeoutType,
      eventId: `${timeoutType}:${row.attemptId}:${row.generation}`,
      idempotencyKey: `${timeoutType}:${row.attemptId}:${row.generation}`,
      source: 'loopctl-watchdog', entityRef: `attempt:${row.attemptId}`,
      payload: { workItemId: row.workItemId, expectedRevision: row.workItemRevision, attemptId: row.attemptId, generation: row.generation }
    }, { ...effectiveProviders, now: () => row.serverReceivedAt! })
    if (receipt.status === 'pending') {
      if (timeoutType === 'attempt_readiness_timed_out') readinessTimedOut++
      else dispatchTimedOut++
    }
  }
  const bridgeUnavailable = readinessTimedOut + dispatchTimedOut
  const cursors = polled.map(batch => ({
    topicId: batch.topicId,
    previousCursor: batch.cursor == null ? null : String(batch.cursor),
    nextCursor: String(batch.nextCursor),
    observations: batch.observations.length
  }))
  if (mode === 'enqueue-only') {
    return { status: 'enqueued', mode, observations, enqueued: ingested.filter(receipt => receipt.status === 'pending').length,
      ingested, cursors, bridgeUnavailable, readinessTimedOut, dispatchTimedOut }
  }
  const driven = await tick(db, ownerUid, { ...options.processingAdapters!, catsco: adapter }, {
    ...(options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents }),
    ...(options.maxEffects === undefined ? {} : { maxEffects: options.maxEffects }),
    ...(workItemId === undefined ? {} : { workItemId })
  })
  return { status: 'driven', mode, observations, enqueued: ingested.filter(receipt => receipt.status === 'pending').length,
    ingested, cursors, bridgeUnavailable, readinessTimedOut, dispatchTimedOut, ...driven }
}
