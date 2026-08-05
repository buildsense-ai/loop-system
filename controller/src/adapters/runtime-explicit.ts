import type { AttemptSnapshot } from '../kernel/types.js'
import type { CandidatePacket } from '../protocol/events.js'
import type { RuntimeProofAdapter, RuntimeProofContext } from './runtime.js'

export class CatscoMessageRuntimeProofAdapter implements RuntimeProofAdapter {
  async verify(ownerUid: string, packet: CandidatePacket, attempt: AttemptSnapshot, context: RuntimeProofContext): Promise<void> {
    if (attempt.proofMode !== 'catsco-message' || packet.proofMode !== 'catsco-message') {
      throw new Error('runtime proof mode mismatch')
    }
    const attestation = context.attestation
    if (!attestation) throw new Error('CatsCo-message proof requires trusted attestation')
    if (packet.ownerUid !== ownerUid) throw new Error('runtime proof owner mismatch')
    if (packet.attemptId !== attempt.attemptId || packet.generation !== attempt.generation) {
      throw new Error('runtime proof attempt/generation mismatch')
    }
    const senderPrincipal = `catsco-user:${attestation.senderUid}`
    if (packet.runtimePrincipal !== attempt.runtimePrincipal || packet.runtimePrincipal !== senderPrincipal) {
      throw new Error('runtime proof principal mismatch')
    }
    if (attestation.topicId !== context.expectedWorkerTopicId) throw new Error('runtime proof worker topic mismatch')
    if (attestation.serverReceivedAt !== context.trustedIngressAt) throw new Error('runtime proof ingress time mismatch')
    if (Date.parse(attestation.serverReceivedAt) > Date.parse(attempt.leaseExpiresAt)) {
      throw new Error('runtime proof lease expired')
    }
    for (const key of ['taskContractHash', 'referenceSnapshotHash', 'writeScopeHash', 'acceptanceContractHash'] as const) {
      if (packet[key] !== attempt[key]) throw new Error('runtime proof contract binding mismatch')
    }
  }
}

/** Selects exactly the mode enrolled on the Attempt; a failure never crosses modes. */
export class ExplicitRuntimeProofAdapter implements RuntimeProofAdapter {
  constructor(
    private readonly ed25519: RuntimeProofAdapter,
    private readonly catscoMessage: RuntimeProofAdapter = new CatscoMessageRuntimeProofAdapter()
  ) {}

  async verify(ownerUid: string, packet: CandidatePacket, attempt: AttemptSnapshot, context: RuntimeProofContext): Promise<void> {
    if ((packet.proofMode ?? 'ed25519') !== attempt.proofMode) throw new Error('runtime proof mode mismatch')
    const adapter = attempt.proofMode === 'ed25519' ? this.ed25519 : this.catscoMessage
    await adapter.verify(ownerUid, packet, attempt, context)
  }
}
