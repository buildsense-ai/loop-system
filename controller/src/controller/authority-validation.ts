import type { SqliteDatabase } from '../store/sqlite.js'
import type { GitHubReadAdapter, GitHubPullRequestObservation } from '../adapters/github.js'
import type { ReviewerAuthorityAdapter } from '../adapters/reviewer.js'
import { ReviewerAuthorityUnavailable } from '../adapters/reviewer.js'
import type { DeliverableClosedValidatedEvent, IngressEvent, ReviewValidatedEvent } from '../protocol/events.js'
import { loadSnapshot } from '../store/repositories.js'
import { digestJson } from '../lib/digest.js'
import { parseCatscoAttestation } from './ingest.js'

export class AuthorityRejection extends Error {
  constructor(readonly code: string, message = code) { super(message) }
}

function evidenceDigest(observed: GitHubPullRequestObservation): string {
  return digestJson({
    repository: observed.repository,
    prNumber: observed.prNumber,
    headSha: observed.headSha,
    baseSha: observed.baseSha,
    changedPaths: [...observed.changedPaths].sort()
  })
}

function requireCurrentCandidate(
  db: SqliteDatabase,
  ownerUid: string,
  workItemId: string,
  expectedRevision: number,
  candidateId: string
) {
  const snapshot = loadSnapshot(db, ownerUid, workItemId)
  const { workItem: work, candidate } = snapshot
  if (!work || !candidate) throw new AuthorityRejection('candidate_not_found')
  if (work.revision !== expectedRevision || candidate.candidateId !== candidateId) {
    throw new AuthorityRejection('stale_candidate_authority')
  }
  return { snapshot, work, candidate }
}

async function readbackCurrentCandidate(
  github: GitHubReadAdapter,
  candidate: ReturnType<typeof requireCurrentCandidate>['candidate']
): Promise<GitHubPullRequestObservation> {
  const deliverable = candidate.deliverable
  const observed = await github.readPullRequest(deliverable.repository, deliverable.prNumber)
  if (
    observed.repository !== deliverable.repository || observed.prNumber !== deliverable.prNumber ||
    observed.headSha !== deliverable.headSha || observed.baseSha !== deliverable.baseSha ||
    evidenceDigest(observed) !== candidate.evidence.digest
  ) throw new AuthorityRejection('reviewed_deliverable_drifted')
  return observed
}

export async function validateReview(
  db: SqliteDatabase,
  ownerUid: string,
  row: Record<string, unknown>,
  event: Extract<IngressEvent, { type: 'review_decided' }>,
  reviewer: ReviewerAuthorityAdapter,
  github: GitHubReadAdapter
): Promise<ReviewValidatedEvent> {
  const p = event.payload
  const { work, candidate } = requireCurrentCandidate(db, ownerUid, p.workItemId, p.expectedRevision, p.candidateId)
  if (work.state !== 'candidate') throw new AuthorityRejection('stale_review')
  if (p.acceptanceContractHash !== work.acceptanceContractHash) throw new AuthorityRejection('review_acceptance_contract_mismatch')
  if (p.reviewedDeliverableDigest !== candidate.deliverable.digest) throw new AuthorityRejection('reviewed_deliverable_digest_mismatch')
  if (p.reviewedHeadSha !== candidate.deliverable.headSha) throw new AuthorityRejection('reviewed_head_mismatch')
  await readbackCurrentCandidate(github, candidate)
  let authority
  try {
    const attestation = parseCatscoAttestation(row)
    authority = await reviewer.verify(ownerUid, p, {
      trustedIngressAt: String(row.trusted_ingress_at),
      expectedStewardTopicId: work.stewardTopicId,
      expectedStewardPrincipal: work.stewardPrincipal,
      ...(attestation ? { attestation } : {})
    })
  } catch (error) {
    if (error instanceof ReviewerAuthorityUnavailable) throw error
    throw new AuthorityRejection('reviewer_authentication_invalid', error instanceof Error ? error.message : String(error))
  }
  if (authority.authenticatedPrincipal !== p.reviewerPrincipal || !authority.receiptDigest) {
    throw new AuthorityRejection('reviewer_authentication_invalid')
  }
  return {
    type: 'review_validated', eventId: event.eventId,
    ingressSequence: Number(row.ingress_sequence), trustedIngressAt: String(row.trusted_ingress_at),
    payload: p, authenticationReceiptDigest: authority.receiptDigest
  }
}

export async function validateDeliverableClosed(
  db: SqliteDatabase,
  ownerUid: string,
  row: Record<string, unknown>,
  event: Extract<IngressEvent, { type: 'deliverable_closed_observed' }>,
  github: GitHubReadAdapter
): Promise<DeliverableClosedValidatedEvent> {
  const p = event.payload
  const { work, candidate } = requireCurrentCandidate(db, ownerUid, p.workItemId, p.expectedRevision, p.candidateId)
  if (work.state !== 'accepted' || work.terminalState !== 'closed') throw new AuthorityRejection('work_item_not_awaiting_close')
  if (p.acceptanceContractHash !== work.acceptanceContractHash) throw new AuthorityRejection('close_acceptance_contract_mismatch')
  const deliverable = candidate.deliverable
  if (
    p.repository !== deliverable.repository || p.prNumber !== deliverable.prNumber ||
    p.mergedHeadSha !== deliverable.headSha || p.deliverableDigest !== deliverable.digest
  ) throw new AuthorityRejection('close_deliverable_mismatch')
  const observed = await readbackCurrentCandidate(github, candidate)
  if (observed.state !== 'closed' || !observed.merged) throw new AuthorityRejection('deliverable_not_merged_closed')
  return {
    type: 'deliverable_closed_validated', eventId: event.eventId,
    ingressSequence: Number(row.ingress_sequence), trustedIngressAt: String(row.trusted_ingress_at),
    payload: p, readbackDigest: digestJson(observed)
  }
}
