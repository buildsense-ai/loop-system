import type { AttemptSnapshot } from '../kernel/types.js'
import type { CandidatePacket } from '../protocol/events.js'
import type { CatscoMessageAttestation } from './catsco.js'
export interface RuntimeProofContext {
  trustedIngressAt: string
  /** Quiet attested evidence lane; legacy Attempts fall back to workerTopicId. */
  expectedEvidenceTopicId: string
  attestation?: CatscoMessageAttestation
}
export interface RuntimeProofAdapter {
  verify(ownerUid: string, packet: CandidatePacket, attempt: AttemptSnapshot, context: RuntimeProofContext): Promise<void>
}
