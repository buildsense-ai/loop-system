import type { SqliteDatabase } from '../store/sqlite.js'
import { immediate } from '../store/sqlite.js'
import type { RuntimeProofAdapter } from '../adapters/runtime.js'
import type { GitHubReadAdapter } from '../adapters/github.js'
import type { ReviewerAuthorityAdapter } from '../adapters/reviewer.js'
import { ReviewerAuthorityUnavailable } from '../adapters/reviewer.js'
import type { KernelEvent, TrustedEvidence } from '../protocol/events.js'
import type { TransitionReceipt } from '../protocol/receipts.js'
import { parseInboxEvent, parseCatscoAttestation } from './ingest.js'
import { CandidateRejection, validateCandidate } from './candidate-validation.js'
import { AuthorityRejection, validateDeliverableClosed, validateReview } from './authority-validation.js'
import { loadSnapshot } from '../store/repositories.js'
import { decide } from '../kernel/decide.js'
import { assertPlan } from '../kernel/invariants.js'
import { canonicalize } from '../lib/canonical-json.js'
import type { AttemptSnapshot, WorkItemSnapshot } from '../kernel/types.js'
import { wakeAgentPostcondition, type WakeAgentEffect } from '../protocol/effects.js'
import { renderActionPacket } from './action-packets.js'

export interface ProcessingAdapters {
  runtime: RuntimeProofAdapter
  github: GitHubReadAdapter
  reviewer: ReviewerAuthorityAdapter
}

function rejectInbox(db: SqliteDatabase, ownerUid: string, inboxId: string, code: string): TransitionReceipt {
  return immediate(db, () => {
    const row = db.prepare('SELECT * FROM inbox WHERE owner_uid=? AND inbox_id=?')
      .get(ownerUid, inboxId) as Record<string, unknown>
    if (row.transition_receipt_json) return JSON.parse(String(row.transition_receipt_json)) as TransitionReceipt
    return rejectInboxWithin(db, ownerUid, row, code)
  })
}

function rejectInboxWithin(
  db: SqliteDatabase,
  ownerUid: string,
  row: Record<string, unknown>,
  code: string
): TransitionReceipt {
  const receipt: TransitionReceipt = {
    eventId: String(row.event_id), idempotencyKey: String(row.idempotency_key),
    status: 'rejected', ingressSequence: Number(row.ingress_sequence), rejectionCode: code
  }
  db.prepare(`UPDATE inbox SET status='rejected',rejection_code=?,transition_receipt_json=?,committed_at=?
    WHERE owner_uid=? AND inbox_id=? AND status='pending'`
  ).run(code, canonicalize(receipt), row.trusted_ingress_at, ownerUid, row.inbox_id)
  return receipt
}

function saveWork(
  db: SqliteDatabase,
  ownerUid: string,
  work: WorkItemSnapshot,
  expected: number | null,
  ledger: number,
  now: string
): void {
  if (expected === null) {
    db.prepare(`INSERT INTO work_items(
      owner_uid,work_item_id,revision,ledger_revision,state,loop_id,profile_id,terminal_state,
      task_contract_hash,reference_snapshot_hash,write_scope_json,write_scope_hash,
      acceptance_contract_hash,github_repo,catsco_project_id,worker_topic_id,steward_topic_id,steward_principal,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ownerUid, work.workItemId, work.revision, ledger, work.state, work.loopId, work.profileId,
      work.terminalState, work.taskContractHash, work.referenceSnapshotHash, canonicalize(work.writeScope),
      work.writeScopeHash, work.acceptanceContractHash, work.githubRepo, work.catscoProjectId,
      work.workerTopicId, work.stewardTopicId, work.stewardPrincipal, now
    )
    return
  }
  const result = db.prepare(`UPDATE work_items SET revision=?,ledger_revision=?,state=?,updated_at=?
    WHERE owner_uid=? AND work_item_id=? AND revision=?`
  ).run(work.revision, ledger, work.state, now, ownerUid, work.workItemId, expected)
  if (result.changes !== 1) throw new Error('optimistic revision conflict')
}

function saveAttempt(
  db: SqliteDatabase,
  ownerUid: string,
  attempt: AttemptSnapshot,
  now: string,
  insertOnly: boolean
): void {
  if (insertOnly) {
    db.prepare(`INSERT INTO attempts(
      owner_uid,attempt_id,work_item_id,work_item_revision,attempt_number,generation,control_state,
      reported_state,connection_state,runtime_principal,proof_key_id,proof_public_key,lease_expires_at,
      task_contract_hash,reference_snapshot_hash,write_scope_hash,acceptance_contract_hash,
      work_bundle_json,started_at,updated_at,proof_mode
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ownerUid, attempt.attemptId, attempt.workItemId, attempt.workItemRevision, attempt.attemptNumber,
      attempt.generation, attempt.controlState, attempt.reportedState, attempt.connectionState,
      attempt.runtimePrincipal, attempt.proofKeyId ?? '', attempt.proofPublicKey ?? '', attempt.leaseExpiresAt,
      attempt.taskContractHash, attempt.referenceSnapshotHash, attempt.writeScopeHash,
      attempt.acceptanceContractHash, canonicalize(attempt.workBundle), null, now, attempt.proofMode
    )
    return
  }
  const startedAt = attempt.controlState === 'running' ? now : null
  const result = db.prepare(`UPDATE attempts SET work_item_revision=?,control_state=?,reported_state=?,
    connection_state=?,started_at=COALESCE(started_at,?),updated_at=?
    WHERE owner_uid=? AND work_item_id=? AND attempt_id=? AND generation=?`
  ).run(
    attempt.workItemRevision, attempt.controlState, attempt.reportedState, attempt.connectionState,
    startedAt, now, ownerUid, attempt.workItemId, attempt.attemptId, attempt.generation
  )
  if (result.changes !== 1) throw new Error('attempt fencing conflict')
}

function obsoletePredecessors(
  db: SqliteDatabase,
  ownerUid: string,
  workItemId: string,
  currentRevision: number,
  now: string
): void {
  db.prepare(`UPDATE outbox SET state='obsolete',claim_token=NULL,claim_expires_at=NULL,
    last_error='obsolete: work item revision advanced',satisfied_at=?
    WHERE owner_uid=? AND state IN ('pending','claimed') AND action_id IN (
      SELECT action_id FROM actions WHERE owner_uid=? AND work_item_id=? AND work_item_revision<?
    )`).run(now, ownerUid, ownerUid, workItemId, currentRevision)
  db.prepare(`UPDATE actions SET state='cancelled' WHERE owner_uid=? AND work_item_id=?
    AND work_item_revision<? AND state IN ('ready','claimed')`
  ).run(ownerUid, workItemId, currentRevision)
}

function storeValidation(db: SqliteDatabase, ownerUid: string, row: Record<string, unknown>, value: unknown): void {
  db.prepare(`UPDATE inbox SET validation_receipt_json=? WHERE owner_uid=? AND inbox_id=?
    AND status='pending' AND validation_receipt_json IS NULL`
  ).run(canonicalize(value), ownerUid, row.inbox_id)
}

export async function processInboxRow(
  db: SqliteDatabase,
  ownerUid: string,
  row: Record<string, unknown>,
  adapters: ProcessingAdapters
): Promise<TransitionReceipt | null> {
  const ingress = parseInboxEvent(String(row.raw_json))
  if (ingress.type === 'candidate_submitted') {
    const reusedCandidate = db.prepare(`SELECT 1 FROM candidates WHERE owner_uid=? AND candidate_id=?`)
      .get(ownerUid, ingress.payload.candidateId)
    if (reusedCandidate) return rejectInbox(db, ownerUid, String(row.inbox_id), 'candidate_id_conflict')
  }
  if (ingress.type === 'runtime_started') {
    const attestation = parseCatscoAttestation(row)
    const snapshot = loadSnapshot(db, ownerUid, ingress.payload.workItemId)
    const attempt = snapshot.attempt
    const work = snapshot.workItem
    const valid = attestation && work && attempt &&
      attestation.topicId === work.workerTopicId &&
      `catsco-user:${attestation.senderUid}` === attempt.runtimePrincipal &&
      ingress.payload.runtimePrincipal === attempt.runtimePrincipal &&
      ingress.payload.attemptId === attempt.attemptId &&
      ingress.payload.generation === attempt.generation &&
      ingress.payload.expectedRevision === work.revision && work.state === 'assigned' &&
      Date.parse(attestation.serverReceivedAt) <= Date.parse(attempt.leaseExpiresAt) &&
      ingress.payload.signature === 'catsco-message-attested'
    if (!valid) {
      const code = !attestation ? 'runtime_started_unattested'
        : attestation.topicId !== work?.workerTopicId ? 'runtime_started_wrong_topic'
        : `catsco-user:${attestation.senderUid}` !== attempt?.runtimePrincipal ? 'runtime_started_wrong_sender'
        : Date.parse(attestation.serverReceivedAt) > Date.parse(attempt?.leaseExpiresAt ?? '') ? 'runtime_started_lease_expired'
        : 'runtime_started_stale'
      return rejectInbox(db, ownerUid, String(row.inbox_id), code)
    }
  }
  let event: KernelEvent = ingress
  try {
    if (ingress.type === 'candidate_submitted') {
      if (row.validation_receipt_json) {
        const validation = JSON.parse(String(row.validation_receipt_json)) as { evidence: TrustedEvidence }
        event = {
          type: 'candidate_validated', eventId: ingress.eventId,
          ingressSequence: Number(row.ingress_sequence), trustedIngressAt: String(row.trusted_ingress_at),
          payload: ingress.payload, evidence: validation.evidence
        }
      } else event = await validateCandidate(db, ownerUid, row, ingress, adapters.runtime, adapters.github)
    } else if (ingress.type === 'review_decided') {
      if (row.validation_receipt_json) {
        const validation = JSON.parse(String(row.validation_receipt_json)) as { authenticationReceiptDigest: string }
        event = {
          type: 'review_validated', eventId: ingress.eventId,
          ingressSequence: Number(row.ingress_sequence), trustedIngressAt: String(row.trusted_ingress_at),
          payload: ingress.payload, authenticationReceiptDigest: validation.authenticationReceiptDigest
        }
      } else {
        event = await validateReview(db, ownerUid, row, ingress, adapters.reviewer, adapters.github)
        storeValidation(db, ownerUid, row, {
          kind: 'review_validated', authenticationReceiptDigest: event.authenticationReceiptDigest
        })
      }
    } else if (ingress.type === 'deliverable_closed_observed') {
      if (row.validation_receipt_json) {
        const validation = JSON.parse(String(row.validation_receipt_json)) as { readbackDigest: string }
        event = {
          type: 'deliverable_closed_validated', eventId: ingress.eventId,
          ingressSequence: Number(row.ingress_sequence), trustedIngressAt: String(row.trusted_ingress_at),
          payload: ingress.payload, readbackDigest: validation.readbackDigest
        }
      } else {
        event = await validateDeliverableClosed(db, ownerUid, row, ingress, adapters.github)
        storeValidation(db, ownerUid, row, { kind: 'deliverable_closed_validated', readbackDigest: event.readbackDigest })
      }
    }
  } catch (error) {
    if (error instanceof CandidateRejection || error instanceof AuthorityRejection) {
      return rejectInbox(db, ownerUid, String(row.inbox_id), error.code)
    }
    if (error instanceof ReviewerAuthorityUnavailable) return null
    return null
  }

  return immediate(db, () => {
    const fresh = db.prepare('SELECT * FROM inbox WHERE owner_uid=? AND inbox_id=?')
      .get(ownerUid, row.inbox_id) as Record<string, unknown>
    if (fresh.status !== 'pending') {
      return fresh.transition_receipt_json
        ? JSON.parse(String(fresh.transition_receipt_json)) as TransitionReceipt
        : null
    }
    const workItemId = event.type === 'reconcile_tick'
      ? event.entityRef.replace(/^work_item:/, '')
      : event.payload.workItemId
    if (event.type === 'work_bundle_proposed') {
      const existingAttempt = db.prepare(`SELECT work_item_id FROM attempts WHERE owner_uid=? AND attempt_id=?`)
        .get(ownerUid, event.payload.attemptId) as { work_item_id: string } | undefined
      if (existingAttempt) return rejectInboxWithin(db, ownerUid, fresh, 'attempt_id_conflict')
    }
    if (event.type === 'candidate_validated') {
      const existingCandidate = db.prepare(`SELECT 1 FROM candidates WHERE owner_uid=? AND candidate_id=?`)
        .get(ownerUid, event.payload.candidateId)
      if (existingCandidate) return rejectInboxWithin(db, ownerUid, fresh, 'candidate_id_conflict')
    }

    const snapshot = loadSnapshot(db, ownerUid, workItemId)
    const plan = decide(snapshot, event)
    assertPlan(plan)
    if (plan.kind === 'reject') return rejectInboxWithin(db, ownerUid, fresh, plan.rejectionCode ?? 'rejected')

    const namespace = db.prepare('SELECT ledger_revision FROM owner_namespaces WHERE owner_uid=?')
      .get(ownerUid) as { ledger_revision: number }
    const ledger = namespace.ledger_revision + 1
    const now = String(fresh.trusted_ingress_at)
    if (plan.nextWorkItem) {
      saveWork(db, ownerUid, plan.nextWorkItem, plan.expectedRevision, ledger, now)
      obsoletePredecessors(db, ownerUid, plan.nextWorkItem.workItemId, plan.nextWorkItem.revision, now)
    }
    if (plan.nextAttempt) saveAttempt(db, ownerUid, plan.nextAttempt, now, event.type === 'work_bundle_proposed')

    const receipt: TransitionReceipt = {
      eventId: String(fresh.event_id), idempotencyKey: String(fresh.idempotency_key),
      status: 'committed', ingressSequence: Number(fresh.ingress_sequence),
      ledgerRevision: ledger, ...plan.receiptFields
    }
    if (plan.candidate) {
      db.prepare(`INSERT INTO candidates(
        owner_uid,candidate_id,attempt_id,generation,work_item_id,work_item_revision,source_event_id,
        ingress_sequence,deliverable_json,deliverable_digest,trusted_evidence_json,commit_receipt_json,committed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        ownerUid, plan.candidate.candidateId, plan.candidate.attemptId, plan.candidate.generation,
        plan.candidate.workItemId, plan.candidate.workItemRevision, fresh.event_id, fresh.ingress_sequence,
        canonicalize(plan.candidate.deliverable), plan.candidate.deliverable.digest,
        canonicalize(plan.candidate.evidence), canonicalize(receipt), now
      )
    }
    for (const action of plan.actions) {
      db.prepare(`INSERT INTO actions(
        owner_uid,action_id,action_key,kind,work_item_id,work_item_revision,target_principal,
        target_digest,target_topic_id,state,created_by_event_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'ready',?,?)`).run(
        ownerUid, action.actionId, action.actionKey, action.kind, action.workItemId,
        action.workItemRevision, action.targetPrincipal, action.targetDigest, action.targetTopicId,
        fresh.event_id, now
      )
    }
    for (const effect of plan.effects) {
      const renderedContent = renderActionPacket(db, ownerUid, effect.actionId)
      const capturedEffect: WakeAgentEffect = { ...effect, renderedContent }
      db.prepare(`INSERT INTO outbox(
        owner_uid,outbox_id,effect_key,effect_type,adapter,action_id,action_work_item_revision,
        action_target_digest,payload_json,precondition_json,postcondition_json,state,next_attempt_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(
        ownerUid, `outbox:${capturedEffect.effectKey}`, capturedEffect.effectKey, capturedEffect.type, 'catsco', capturedEffect.actionId,
        capturedEffect.actionWorkItemRevision, capturedEffect.targetDigest, canonicalize(capturedEffect),
        canonicalize({ actionState: 'ready', workItemRevision: capturedEffect.actionWorkItemRevision, targetDigest: capturedEffect.targetDigest }),
        canonicalize(wakeAgentPostcondition(ownerUid, capturedEffect)), now, now
      )
    }
    db.prepare('UPDATE owner_namespaces SET ledger_revision=? WHERE owner_uid=?').run(ledger, ownerUid)
    db.prepare(`UPDATE inbox SET status='committed',transition_receipt_json=?,committed_at=?
      WHERE owner_uid=? AND inbox_id=?`).run(canonicalize(receipt), now, ownerUid, fresh.inbox_id)
    return receipt
  })
}

export async function processPending(
  db: SqliteDatabase,
  ownerUid: string,
  adapters: ProcessingAdapters,
  maxEvents = 100
): Promise<TransitionReceipt[]> {
  const rows = db.prepare(`SELECT * FROM inbox WHERE owner_uid=? AND status='pending'
    ORDER BY ingress_sequence LIMIT ?`).all(ownerUid, maxEvents) as Record<string, unknown>[]
  const receipts: TransitionReceipt[] = []
  for (const row of rows) {
    const receipt = await processInboxRow(db, ownerUid, row, adapters)
    if (!receipt) break
    receipts.push(receipt)
  }
  return receipts
}
