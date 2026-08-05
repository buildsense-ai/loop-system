import { createPublicKey, verify } from 'node:crypto'
import { canonicalize } from '../lib/canonical-json.js'
import type { RuntimeProofAdapter, RuntimeProofContext } from './runtime.js'
import type { AttemptSnapshot } from '../kernel/types.js'
import type { CandidatePacket } from '../protocol/events.js'

export function runtimeProofPayload(packet: CandidatePacket): string {
  const { signature: _signature, ...signed } = packet
  return canonicalize(signed)
}
export class Ed25519RuntimeProofAdapter implements RuntimeProofAdapter {
  async verify(ownerUid: string, packet: CandidatePacket, attempt: AttemptSnapshot, context: RuntimeProofContext): Promise<void> {
    if (attempt.proofMode !== 'ed25519' || (packet.proofMode ?? 'ed25519') !== 'ed25519') throw new Error('runtime proof mode mismatch')
    if (packet.ownerUid !== ownerUid) throw new Error('runtime proof owner mismatch')
    if (packet.attemptId !== attempt.attemptId || packet.generation !== attempt.generation) throw new Error('runtime proof attempt/generation mismatch')
    if (packet.runtimePrincipal !== attempt.runtimePrincipal) throw new Error('runtime proof principal mismatch')
    if (Date.parse(context.trustedIngressAt) > Date.parse(attempt.leaseExpiresAt)) throw new Error('runtime proof lease expired')
    if (!attempt.proofPublicKey || !packet.signature) throw new Error('runtime proof key/signature missing')
    let valid = false
    try { valid = verify(null, Buffer.from(runtimeProofPayload(packet)), createPublicKey(attempt.proofPublicKey), Buffer.from(packet.signature, 'base64')) } catch { valid = false }
    if (!valid) throw new Error('invalid runtime signature')
  }
}
