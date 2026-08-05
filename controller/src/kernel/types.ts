import type { ExecutableEffect } from '../protocol/effects.js'
import type { Deliverable, TrustedEvidence } from '../protocol/events.js'

export type WorkState = 'ready' | 'assigned' | 'in_progress' | 'candidate' | 'changes_requested' | 'accepted' | 'closed'
export interface WorkItemSnapshot {
  workItemId: string; revision: number; state: WorkState; loopId: string; profileId: string; terminalState: 'accepted' | 'closed'
  taskContractHash: string; referenceSnapshotHash: string; writeScope: string[]; writeScopeHash: string;
  acceptanceContractHash: string; githubRepo: string; catscoProjectId: string; workerTopicId: string; stewardTopicId: string;
  stewardPrincipal: string
}
export interface AttemptSnapshot {
  attemptId: string; workItemId: string; workItemRevision: number; attemptNumber: number; generation: number;
  controlState: string; reportedState: string; connectionState: string; runtimePrincipal: string;
  proofMode: 'ed25519' | 'catsco-message'; proofKeyId?: string; proofPublicKey?: string;
  leaseExpiresAt: string; taskContractHash: string; referenceSnapshotHash: string;
  writeScopeHash: string; acceptanceContractHash: string; workBundle: unknown
}
export interface CandidateSnapshot {
  candidateId: string; attemptId: string; generation: number; workItemId: string; workItemRevision: number;
  deliverable: Deliverable; evidence: TrustedEvidence
}
export interface KernelSnapshot { ownerUid: string; workItem: WorkItemSnapshot | null; attempt: AttemptSnapshot | null; candidate: CandidateSnapshot | null }
export interface ActionPlan { actionId: string; actionKey: string; kind: 'execute_attempt'|'review_candidate'|'plan_next'; workItemId: string; workItemRevision: number; targetPrincipal: string; targetDigest: string; targetTopicId: string }
export interface CandidatePlan { candidateId: string; attemptId: string; generation: number; workItemId: string; workItemRevision: number; deliverable: Deliverable; evidence: TrustedEvidence }
export interface TransitionPlan {
  kind: 'commit'|'reject'; rejectionCode?: string; expectedRevision: number | null;
  nextWorkItem?: WorkItemSnapshot; nextAttempt?: AttemptSnapshot; candidate?: CandidatePlan;
  actions: ActionPlan[]; effects: ExecutableEffect[]; receiptFields: Record<string, unknown>
}
