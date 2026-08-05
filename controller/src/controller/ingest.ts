import type { SqliteDatabase } from '../store/sqlite.js'
import { immediate } from '../store/sqlite.js'
import { ingressEventSchema, type IngressEvent } from '../protocol/events.js'
import type { TransitionReceipt } from '../protocol/receipts.js'
import { canonicalize } from '../lib/canonical-json.js'
import { sha256 } from '../lib/digest.js'
import type { CatscoMessageAttestation } from '../adapters/catsco.js'

export interface Providers { now(): string; id(prefix: string): string }
export const defaultProviders: Providers = {
  now: () => new Date().toISOString(),
  id: prefix => `${prefix}_${crypto.randomUUID()}`
}

const receiptFromInbox = (row: Record<string, unknown>): TransitionReceipt => row.transition_receipt_json
  ? JSON.parse(String(row.transition_receipt_json)) as TransitionReceipt
  : {
      eventId: String(row.event_id), idempotencyKey: String(row.idempotency_key),
      status: row.status as TransitionReceipt['status'], ingressSequence: Number(row.ingress_sequence),
      ...(row.rejection_code ? { rejectionCode: String(row.rejection_code) } : {})
    }

export function ingest(
  db: SqliteDatabase,
  ownerUid: string,
  raw: unknown,
  providers: Providers = defaultProviders,
  trustedIngress?: string | CatscoMessageAttestation
): TransitionReceipt {
  const event = ingressEventSchema.parse(raw)
  const canonical = canonicalize(event)
  const attestation = typeof trustedIngress === 'object' ? trustedIngress : undefined
  if (attestation && (
    !attestation.topicId || !attestation.seqId || !attestation.senderUid ||
    !Number.isFinite(Date.parse(attestation.serverReceivedAt))
  )) throw new Error('invalid CatsCo message attestation')
  const attestationJson = attestation ? canonicalize(attestation) : null
  const attestationDigest = attestationJson ? sha256(attestationJson) : null
  const rawDigest = attestationJson ? sha256(canonicalize({ event, attestation })) : sha256(canonical)
  return immediate(db, () => {
    const byIdempotency = db.prepare(`SELECT * FROM inbox WHERE owner_uid=? AND idempotency_key=?`)
      .get(ownerUid, event.idempotencyKey) as Record<string, unknown> | undefined
    const byEvent = db.prepare(`SELECT * FROM inbox WHERE owner_uid=? AND event_id=?`)
      .get(ownerUid, event.eventId) as Record<string, unknown> | undefined

    if (byIdempotency || byEvent) {
      const sameRow = byIdempotency && byEvent && byIdempotency.inbox_id === byEvent.inbox_id
      const exactDuplicate = sameRow && byIdempotency.raw_digest === rawDigest &&
        byIdempotency.event_id === event.eventId && byIdempotency.idempotency_key === event.idempotencyKey
      if (exactDuplicate) return receiptFromInbox(byIdempotency)

      const existingConflict = db.prepare(`SELECT transition_receipt_json FROM ingress_conflicts
        WHERE owner_uid=? AND raw_digest=?`).get(ownerUid, rawDigest) as { transition_receipt_json: string } | undefined
      if (existingConflict) return JSON.parse(existingConflict.transition_receipt_json) as TransitionReceipt

      const namespace = db.prepare(`SELECT next_ingress_sequence FROM owner_namespaces WHERE owner_uid=?`)
        .get(ownerUid) as { next_ingress_sequence: number } | undefined
      if (!namespace) throw new Error('owner namespace is not initialized')
      const ingressSequence = namespace.next_ingress_sequence
      const conflictId = `conflict:${rawDigest}`
      const receipt: TransitionReceipt = {
        eventId: event.eventId, idempotencyKey: event.idempotencyKey, status: 'rejected',
        ingressSequence, rejectionCode: 'identifier_conflict', conflictId
      }
      const now = providers.now()
      db.prepare(`UPDATE owner_namespaces SET next_ingress_sequence=next_ingress_sequence+1 WHERE owner_uid=?`).run(ownerUid)
      db.prepare(`INSERT INTO ingress_conflicts(
        owner_uid,conflict_id,event_id,idempotency_key,raw_digest,canonical_json,conflict_code,
        transition_receipt_json,ingress_sequence,recorded_at,catsco_attestation_json,catsco_attestation_digest
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        ownerUid, conflictId, event.eventId, event.idempotencyKey, rawDigest, canonical,
        'identifier_conflict', canonicalize(receipt), ingressSequence, now, attestationJson, attestationDigest
      )
      return receipt
    }

    const namespace = db.prepare('SELECT next_ingress_sequence FROM owner_namespaces WHERE owner_uid=?')
      .get(ownerUid) as { next_ingress_sequence: number } | undefined
    if (!namespace) throw new Error('owner namespace is not initialized')
    const sequence = namespace.next_ingress_sequence
    const now = providers.now()
    db.prepare('UPDATE owner_namespaces SET next_ingress_sequence=next_ingress_sequence+1 WHERE owner_uid=?').run(ownerUid)
    db.prepare(`INSERT INTO inbox(
      owner_uid,inbox_id,event_id,idempotency_key,source,entity_ref,ingress_sequence,trusted_ingress_at,
      raw_json,raw_digest,canonical_json,catsco_attestation_json,catsco_attestation_digest,status
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`).run(
      ownerUid, providers.id('inbox'), event.eventId, event.idempotencyKey, event.source,
      event.entityRef, sequence, attestation?.serverReceivedAt ?? (typeof trustedIngress === 'string' ? trustedIngress : now),
      canonical, rawDigest, canonical, attestationJson, attestationDigest
    )
    return { eventId: event.eventId, idempotencyKey: event.idempotencyKey, status: 'pending', ingressSequence: sequence }
  })
}

export function parseInboxEvent(rawJson: string): IngressEvent {
  return ingressEventSchema.parse(JSON.parse(rawJson))
}

export function parseCatscoAttestation(row: Record<string, unknown>): CatscoMessageAttestation | undefined {
  if (!row.catsco_attestation_json) return undefined
  return JSON.parse(String(row.catsco_attestation_json)) as CatscoMessageAttestation
}
