import type { ReviewDecisionPayload } from '../protocol/events.js'
import type { CatscoMessageAttestation } from './catsco.js'
import { digestJson } from '../lib/digest.js'

export interface ReviewerAuthorityReceipt {
  authenticatedPrincipal: string
  receiptDigest: string
}

export interface ReviewerAuthorityContext {
  trustedIngressAt: string
  expectedStewardTopicId: string
  expectedStewardPrincipal: string
  attestation?: CatscoMessageAttestation
}

export interface ReviewerAuthorityAdapter {
  verify(
    ownerUid: string,
    decision: ReviewDecisionPayload,
    context: ReviewerAuthorityContext
  ): Promise<ReviewerAuthorityReceipt>
}

export class ReviewerAuthorityUnavailable extends Error {}

/** Authentication must be supplied by a trusted CatsCo/human bridge. */
export class UnavailableReviewerAuthorityAdapter implements ReviewerAuthorityAdapter {
  async verify(): Promise<ReviewerAuthorityReceipt> {
    throw new ReviewerAuthorityUnavailable('authenticated reviewer proof adapter is unavailable')
  }
}

/** Attested CatsCo messages are authoritative; unattested input is delegated explicitly. */
export class CatscoReviewerAuthorityAdapter implements ReviewerAuthorityAdapter {
  constructor(private readonly unattested: ReviewerAuthorityAdapter = new UnavailableReviewerAuthorityAdapter()) {}

  async verify(
    ownerUid: string,
    decision: ReviewDecisionPayload,
    context: ReviewerAuthorityContext
  ): Promise<ReviewerAuthorityReceipt> {
    const attestation = context.attestation
    if (!attestation) return this.unattested.verify(ownerUid, decision, context)
    const principal = `catsco-user:${attestation.senderUid}`
    if (attestation.topicId !== context.expectedStewardTopicId) throw new Error('reviewer topic mismatch')
    if (principal !== context.expectedStewardPrincipal || principal !== decision.reviewerPrincipal) {
      throw new Error('reviewer principal mismatch')
    }
    if (attestation.serverReceivedAt !== context.trustedIngressAt) throw new Error('reviewer ingress time mismatch')
    return { authenticatedPrincipal: principal, receiptDigest: digestJson(attestation) }
  }
}
