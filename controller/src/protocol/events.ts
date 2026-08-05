import { z } from 'zod'

const id = z.string().min(1)
const hash = z.string().min(8)
const base = { eventId: id, idempotencyKey: id, source: id, entityRef: id }
const contracts = {
  taskContractHash: hash,
  referenceSnapshotHash: hash,
  writeScopeHash: hash,
  acceptanceContractHash: hash
}
export const deliverableSchema = z.object({
  kind: z.literal('github_pr'), repository: id, prNumber: z.number().int().positive(),
  headSha: id, baseSha: id, digest: hash
}).strict()
export type Deliverable = z.infer<typeof deliverableSchema>

export const candidatePacketSchema = z.object({
  ownerUid: id, workItemId: id, workItemRevision: z.number().int().positive(), attemptId: id,
  generation: z.number().int().nonnegative(), runtimePrincipal: id,
  candidateId: id, deliverable: deliverableSchema, ...contracts,
  proofMode: z.enum(['ed25519', 'catsco-message']).optional(), signature: id.optional()
}).strict().superRefine((packet, context) => {
  const mode = packet.proofMode ?? 'ed25519'
  if (mode === 'ed25519' && !packet.signature) {
    context.addIssue({ code: 'custom', path: ['signature'], message: 'Ed25519 proof requires signature' })
  }
  if (mode === 'catsco-message' && packet.signature !== undefined) {
    context.addIssue({ code: 'custom', path: ['signature'], message: 'CatsCo-message proof must not carry signature' })
  }
})
export type CandidatePacket = z.infer<typeof candidatePacketSchema>

const workItemRegistered = z.object({ ...base, type: z.literal('work_item_registered'), payload: z.object({
  workItemId: id, loopId: id, profileId: id, terminalState: z.enum(['accepted', 'closed']), ...contracts,
  writeScope: z.array(id), githubRepo: id, catscoProjectId: id, workerTopicId: id, stewardTopicId: id,
  stewardPrincipal: id.optional()
}).strict() }).strict()
const workBundlePayload = z.object({
  workItemId: id, expectedRevision: z.number().int().positive(), attemptId: id,
  attemptNumber: z.number().int().positive(), generation: z.number().int().nonnegative(),
  runtimePrincipal: id, proofMode: z.enum(['ed25519', 'catsco-message']).optional(),
  proofKeyId: id.optional(), proofPublicKey: id.optional(), leaseExpiresAt: z.string().datetime(),
  workBundle: z.object({ contractDigest: hash, instructions: id, deliverables: z.array(id) }).strict(), ...contracts
}).strict().superRefine((payload, context) => {
  const mode = payload.proofMode ?? 'ed25519'
  if (mode === 'ed25519' && (!payload.proofKeyId || !payload.proofPublicKey)) {
    context.addIssue({ code: 'custom', path: ['proofKeyId'], message: 'Ed25519 mode requires proof key id and public key' })
  }
  if (mode === 'catsco-message' && (payload.proofKeyId !== undefined || payload.proofPublicKey !== undefined)) {
    context.addIssue({ code: 'custom', path: ['proofKeyId'], message: 'CatsCo-message mode must not carry proof keys' })
  }
})
const workBundleProposed = z.object({ ...base, type: z.literal('work_bundle_proposed'), payload: workBundlePayload }).strict()
const runtimeStarted = z.object({ ...base, type: z.literal('runtime_started'), payload: z.object({
  workItemId: id, expectedRevision: z.number().int().positive(), attemptId: id, generation: z.number().int().nonnegative(),
  runtimePrincipal: id, signature: id
}).strict() }).strict()
const progress = z.object({ ...base, type: z.literal('runtime_progress_observed'), payload: z.object({ workItemId: id, attemptId: id, reportedState: id }).strict() }).strict()
const connection = z.object({ ...base, type: z.literal('runtime_connection_observed'), payload: z.object({ workItemId: id, attemptId: id, connectionState: z.enum(['connected','disconnected','unknown']) }).strict() }).strict()
const taskStatus = z.object({ ...base, type: z.literal('catsco_task_status_observed'), payload: z.object({ workItemId: id, attemptId: id, state: id, runId: id }).strict() }).strict()
const candidateSubmitted = z.object({ ...base, type: z.literal('candidate_submitted'), payload: candidatePacketSchema }).strict()
const orphan = z.object({ ...base, type: z.literal('orphan_deliverable_observed'), payload: z.object({ workItemId: id, repository: id, prNumber: z.number().int().positive(), headSha: id }).strict() }).strict()
const reconcile = z.object({ ...base, type: z.literal('reconcile_tick'), payload: z.object({ scope: id }).strict() }).strict()
export const reviewDecisionPayloadSchema = z.object({
  workItemId: id, expectedRevision: z.number().int().positive(), candidateId: id,
  outcome: z.enum(['accepted','changes_requested']), reviewerPrincipal: id,
  authenticationRef: id.optional(), reviewerProof: id.optional(), reviewedHeadSha: id,
  reviewedDeliverableDigest: hash, acceptanceContractHash: hash
}).strict()
export type ReviewDecisionPayload = z.infer<typeof reviewDecisionPayloadSchema>
const review = z.object({ ...base, type: z.literal('review_decided'), payload: reviewDecisionPayloadSchema }).strict()
export const deliverableClosedPayloadSchema = z.object({
  workItemId: id, expectedRevision: z.number().int().positive(), candidateId: id,
  repository: id, prNumber: z.number().int().positive(), mergedHeadSha: id,
  deliverableDigest: hash, acceptanceContractHash: hash, observationRef: id
}).strict()
const deliverableClosed = z.object({ ...base, type: z.literal('deliverable_closed_observed'), payload: deliverableClosedPayloadSchema }).strict()

export const ingressEventSchema = z.discriminatedUnion('type', [
  workItemRegistered, workBundleProposed, runtimeStarted, progress, connection,
  taskStatus, candidateSubmitted, orphan, reconcile, review, deliverableClosed
])
export type IngressEvent = z.infer<typeof ingressEventSchema>

export interface TrustedEvidence { repository: string; prNumber: number; headSha: string; baseSha: string; changedPaths: string[]; digest: string }
export interface CandidateValidatedEvent {
  type: 'candidate_validated'; eventId: string; ingressSequence: number; trustedIngressAt: string;
  payload: CandidatePacket; evidence: TrustedEvidence
}
export interface ReviewValidatedEvent {
  type: 'review_validated'; eventId: string; ingressSequence: number; trustedIngressAt: string;
  payload: ReviewDecisionPayload; authenticationReceiptDigest: string
}
export interface DeliverableClosedValidatedEvent {
  type: 'deliverable_closed_validated'; eventId: string; ingressSequence: number; trustedIngressAt: string;
  payload: z.infer<typeof deliverableClosedPayloadSchema>; readbackDigest: string
}
export type KernelEvent = IngressEvent | CandidateValidatedEvent | ReviewValidatedEvent | DeliverableClosedValidatedEvent
