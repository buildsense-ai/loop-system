import { digestJson } from '../lib/digest.js'
import type { KernelEvent } from '../protocol/events.js'
import type { ActionPlan, KernelSnapshot, TransitionPlan, WorkItemSnapshot } from './types.js'

const reject = (code: string, expectedRevision: number | null): TransitionPlan => ({ kind: 'reject', rejectionCode: code, expectedRevision, actions: [], effects: [], receiptFields: {} })
const stable = (...parts: (string|number)[]) => parts.join(':')
const wake = (action: ActionPlan) => ({
  type: 'wake_agent' as const, effectKey: `wake:${action.actionKey}`, actionId: action.actionId,
  actionWorkItemRevision: action.workItemRevision, targetPrincipal: action.targetPrincipal,
  targetDigest: action.targetDigest, targetTopicId: action.targetTopicId, packetDigest: digestJson(action)
})

export function decide(snapshot: KernelSnapshot, event: KernelEvent): TransitionPlan {
  const work = snapshot.workItem
  if (event.type === 'work_item_registered') {
    if (work) return reject('work_item_exists', work.revision)
    const p = event.payload
    const next: WorkItemSnapshot = { ...p, stewardPrincipal: p.stewardPrincipal ?? 'steward', revision: 1, state: 'ready' }
    return { kind: 'commit', expectedRevision: null, nextWorkItem: next, actions: [], effects: [], receiptFields: { workItemId: p.workItemId, workItemRevision: 1 } }
  }
  if (!work) return reject('work_item_not_found', null)
  if ('workItemId' in event.payload && event.payload.workItemId !== work.workItemId) return reject('work_item_mismatch', work.revision)

  if (event.type === 'work_bundle_proposed') {
    const p = event.payload
    if (work.state !== 'ready' && work.state !== 'changes_requested') return reject('work_item_not_dispatchable', work.revision)
    if (p.expectedRevision !== work.revision) return reject('stale_work_item_revision', work.revision)
    if (snapshot.attempt && snapshot.attempt.generation >= p.generation) return reject('stale_generation', work.revision)
    for (const key of ['taskContractHash','referenceSnapshotHash','writeScopeHash','acceptanceContractHash'] as const)
      if (p[key] !== work[key]) return reject('contract_binding_mismatch', work.revision)
    const revision = work.revision + 1
    const nextWorkItem = { ...work, revision, state: 'assigned' as const }
    const nextAttempt = { attemptId: p.attemptId, workItemId: p.workItemId, workItemRevision: revision, attemptNumber: p.attemptNumber,
      generation: p.generation, controlState: 'allocated', reportedState: 'unknown', connectionState: 'unknown', runtimePrincipal: p.runtimePrincipal,
      proofMode: p.proofMode ?? 'ed25519', ...(p.proofKeyId ? { proofKeyId: p.proofKeyId } : {}),
      ...(p.proofPublicKey ? { proofPublicKey: p.proofPublicKey } : {}), leaseExpiresAt: p.leaseExpiresAt,
      taskContractHash: p.taskContractHash, referenceSnapshotHash: p.referenceSnapshotHash, writeScopeHash: p.writeScopeHash,
      acceptanceContractHash: p.acceptanceContractHash, workBundle: p.workBundle }
    const action: ActionPlan = { actionId: stable('action','execute',p.attemptId,p.generation), actionKey: stable('execute_attempt',p.attemptId,p.generation), kind: 'execute_attempt',
      workItemId: work.workItemId, workItemRevision: revision, targetPrincipal: p.runtimePrincipal,
      targetDigest: p.workBundle.contractDigest, targetTopicId: work.workerTopicId }
    return { kind: 'commit', expectedRevision: work.revision, nextWorkItem, nextAttempt, actions: [action], effects: [wake(action)], receiptFields: { workItemId: work.workItemId, workItemRevision: revision, actionIds: [action.actionId] } }
  }
  const attempt = snapshot.attempt
  if (event.type === 'runtime_started') {
    const p = event.payload
    if (!attempt || attempt.attemptId !== p.attemptId) return reject('attempt_mismatch', work.revision)
    if (work.state !== 'assigned' || p.expectedRevision !== work.revision) return reject('stale_work_item_revision', work.revision)
    if (attempt.generation !== p.generation) return reject('stale_generation', work.revision)
    if (attempt.runtimePrincipal !== p.runtimePrincipal) return reject('runtime_principal_mismatch', work.revision)
    const revision = work.revision + 1
    return { kind: 'commit', expectedRevision: work.revision, nextWorkItem: { ...work, revision, state: 'in_progress' },
      nextAttempt: { ...attempt, workItemRevision: revision, controlState: 'running', connectionState: 'connected' }, actions: [], effects: [], receiptFields: { workItemId: work.workItemId, workItemRevision: revision } }
  }
  if (event.type === 'runtime_progress_observed' || event.type === 'runtime_connection_observed' || event.type === 'catsco_task_status_observed') {
    if (!attempt || attempt.attemptId !== event.payload.attemptId) return reject('attempt_mismatch', work.revision)
    const nextAttempt = { ...attempt }
    if (event.type === 'runtime_progress_observed') nextAttempt.reportedState = event.payload.reportedState === 'completed' ? 'completion_reported' : event.payload.reportedState
    if (event.type === 'runtime_connection_observed') nextAttempt.connectionState = event.payload.connectionState
    if (event.type === 'catsco_task_status_observed') nextAttempt.reportedState = event.payload.state === 'completed' ? 'completion_reported' : event.payload.state
    return { kind: 'commit', expectedRevision: work.revision, nextAttempt, actions: [], effects: [], receiptFields: { workItemId: work.workItemId, workItemRevision: work.revision } }
  }
  if (event.type === 'attempt_abandoned') {
    const p = event.payload
    if (!attempt || attempt.attemptId !== p.attemptId) return reject('attempt_mismatch', work.revision)
    if (attempt.generation !== p.generation) return reject('stale_generation', work.revision)
    if (snapshot.candidate?.attemptId === attempt.attemptId && snapshot.candidate.generation === attempt.generation) return reject('candidate_exists', work.revision)
    if (p.expectedRevision !== work.revision) return reject('stale_work_item_revision', work.revision)
    if (work.state !== 'in_progress' || attempt.controlState !== 'running') return reject('attempt_not_running', work.revision)
    if (Date.parse(event.trustedIngressAt) <= Date.parse(attempt.leaseExpiresAt)) return reject('attempt_not_expired', work.revision)
    const revision = work.revision + 1
    return { kind: 'commit', expectedRevision: work.revision,
      nextWorkItem: { ...work, revision, state: 'ready' },
      nextAttempt: { ...attempt, workItemRevision: revision, controlState: 'abandoned', reportedState: 'abandoned', connectionState: 'disconnected' },
      actions: [], effects: [], receiptFields: { workItemId: work.workItemId, workItemRevision: revision, attemptId: attempt.attemptId, generation: attempt.generation } }
  }
  if (event.type === 'candidate_submitted') return reject('candidate_not_validated', work.revision)
  if (event.type === 'candidate_validated') {
    const p = event.payload
    if (!attempt || attempt.attemptId !== p.attemptId) return reject('attempt_mismatch', work.revision)
    if (work.state !== 'in_progress') return reject('work_item_not_in_progress', work.revision)
    if (p.workItemRevision !== work.revision) return reject('stale_work_item_revision', work.revision)
    if (p.generation !== attempt.generation) return reject('stale_generation', work.revision)
    if (p.runtimePrincipal !== attempt.runtimePrincipal) return reject('runtime_principal_mismatch', work.revision)
    if (Date.parse(event.trustedIngressAt) > Date.parse(attempt.leaseExpiresAt)) return reject('lease_expired', work.revision)
    for (const key of ['taskContractHash','referenceSnapshotHash','writeScopeHash','acceptanceContractHash'] as const)
      if (p[key] !== work[key] || p[key] !== attempt[key]) return reject('contract_binding_mismatch', work.revision)
    const expectedDeliverableDigest = digestJson({ kind: p.deliverable.kind, repository: p.deliverable.repository, prNumber: p.deliverable.prNumber, headSha: p.deliverable.headSha, baseSha: p.deliverable.baseSha })
    if (p.deliverable.digest !== expectedDeliverableDigest) return reject('deliverable_digest_mismatch', work.revision)
    if (p.deliverable.repository !== work.githubRepo || event.evidence.repository !== work.githubRepo || event.evidence.headSha !== p.deliverable.headSha || event.evidence.baseSha !== p.deliverable.baseSha) return reject('trusted_evidence_mismatch', work.revision)
    const { digest: evidenceDigest, ...evidenceBody } = event.evidence
    if (evidenceDigest !== digestJson(evidenceBody)) return reject('trusted_evidence_digest_mismatch', work.revision)
    const revision = work.revision + 1
    const action: ActionPlan = { actionId: stable('action','review',p.attemptId,p.generation), actionKey: stable('review_candidate',p.attemptId,p.generation), kind: 'review_candidate',
      workItemId: work.workItemId, workItemRevision: revision, targetPrincipal: work.stewardPrincipal, targetDigest: p.deliverable.digest, targetTopicId: work.stewardTopicId }
    return { kind: 'commit', expectedRevision: work.revision, nextWorkItem: { ...work, revision, state: 'candidate' },
      nextAttempt: { ...attempt, workItemRevision: revision, controlState: 'candidate_committed' },
      candidate: { candidateId: p.candidateId, attemptId: p.attemptId, generation: p.generation, workItemId: p.workItemId, workItemRevision: p.workItemRevision, deliverable: p.deliverable, evidence: event.evidence },
      actions: [action], effects: [wake(action)], receiptFields: { workItemId: work.workItemId, workItemRevision: revision, candidateId: p.candidateId, actionIds: [action.actionId] } }
  }
  if (event.type === 'review_decided') return reject('review_not_validated', work.revision)
  if (event.type === 'review_validated') {
    const p = event.payload
    const candidate = snapshot.candidate
    if (!attempt) return reject('attempt_mismatch', work.revision)
    if (work.state !== 'candidate' || p.expectedRevision !== work.revision || candidate?.candidateId !== p.candidateId) return reject('stale_review', work.revision)
    if (p.acceptanceContractHash !== work.acceptanceContractHash) return reject('review_acceptance_contract_mismatch', work.revision)
    if (p.reviewedDeliverableDigest !== candidate.deliverable.digest || p.reviewedHeadSha !== candidate.deliverable.headSha || candidate.evidence.headSha !== p.reviewedHeadSha) return reject('reviewed_deliverable_mismatch', work.revision)
    const decisionBinding = digestJson({ candidateId: p.candidateId, outcome: p.outcome,
      reviewedHeadSha: p.reviewedHeadSha, reviewedDeliverableDigest: p.reviewedDeliverableDigest,
      acceptanceContractHash: p.acceptanceContractHash, reviewerPrincipal: p.reviewerPrincipal,
      authenticationReceiptDigest: event.authenticationReceiptDigest })
    const revision = work.revision + 1
    if (p.outcome === 'changes_requested') return { kind: 'commit', expectedRevision: work.revision, nextWorkItem: { ...work, revision, state: 'changes_requested' },
      nextAttempt: { ...attempt, workItemRevision: revision, controlState: 'changes_requested' },
      actions: [], effects: [], receiptFields: { workItemId: work.workItemId, workItemRevision: revision } }
    const nextWorkItem = { ...work, revision, state: 'accepted' as const }
    if (work.terminalState === 'closed') return { kind: 'commit', expectedRevision: work.revision, nextWorkItem,
      nextAttempt: { ...attempt, workItemRevision: revision, controlState: 'accepted' }, actions: [], effects: [],
      receiptFields: { workItemId: work.workItemId, workItemRevision: revision } }
    const action: ActionPlan = { actionId: stable('action','plan_next',work.workItemId,revision), actionKey: stable('plan_next',work.workItemId,revision), kind: 'plan_next',
      workItemId: work.workItemId, workItemRevision: revision, targetPrincipal: work.stewardPrincipal, targetDigest: decisionBinding, targetTopicId: work.stewardTopicId }
    return { kind: 'commit', expectedRevision: work.revision, nextWorkItem, nextAttempt: { ...attempt, workItemRevision: revision, controlState: 'accepted' },
      actions: [action], effects: [wake(action)], receiptFields: { workItemId: work.workItemId, workItemRevision: revision, actionIds: [action.actionId] } }
  }
  if (event.type === 'deliverable_closed_observed') return reject('deliverable_close_not_validated', work.revision)
  if (event.type === 'deliverable_closed_validated') {
    const p = event.payload
    const candidate = snapshot.candidate
    if (!attempt || !candidate) return reject('candidate_not_found', work.revision)
    if (work.state !== 'accepted' || work.terminalState !== 'closed' || p.expectedRevision !== work.revision) return reject('work_item_not_awaiting_close', work.revision)
    if (candidate.candidateId !== p.candidateId || candidate.deliverable.repository !== p.repository ||
      candidate.deliverable.prNumber !== p.prNumber || candidate.deliverable.headSha !== p.mergedHeadSha ||
      candidate.deliverable.digest !== p.deliverableDigest || p.acceptanceContractHash !== work.acceptanceContractHash) return reject('close_deliverable_mismatch', work.revision)
    const revision = work.revision + 1
    const closeBinding = digestJson({ candidateId: p.candidateId, mergedHeadSha: p.mergedHeadSha,
      deliverableDigest: p.deliverableDigest, acceptanceContractHash: p.acceptanceContractHash,
      observationRef: p.observationRef, readbackDigest: event.readbackDigest })
    const action: ActionPlan = { actionId: stable('action','plan_next',work.workItemId,revision), actionKey: stable('plan_next',work.workItemId,revision), kind: 'plan_next',
      workItemId: work.workItemId, workItemRevision: revision, targetPrincipal: work.stewardPrincipal, targetDigest: closeBinding, targetTopicId: work.stewardTopicId }
    return { kind: 'commit', expectedRevision: work.revision, nextWorkItem: { ...work, revision, state: 'closed' },
      nextAttempt: { ...attempt, workItemRevision: revision, controlState: 'closed' }, actions: [action], effects: [wake(action)],
      receiptFields: { workItemId: work.workItemId, workItemRevision: revision, actionIds: [action.actionId] } }
  }
  if (event.type === 'orphan_deliverable_observed' || event.type === 'reconcile_tick') return { kind: 'commit', expectedRevision: work.revision, actions: [], effects: [], receiptFields: { workItemId: work.workItemId, workItemRevision: work.revision } }
  return reject('unsupported_event', work.revision)
}
