import { canonicalize } from '../lib/canonical-json.js'
import { sha256 } from '../lib/digest.js'

export interface WakeAgentEffect {
  type: 'wake_agent'
  effectKey: string
  actionId: string
  actionWorkItemRevision: number
  targetPrincipal: string
  targetDigest: string
  targetTopicId: string
  packetDigest: string
  /** Canonical Agent-facing packet captured at action commit time. */
  renderedContent?: string
}
export type ExecutableEffect = WakeAgentEffect

export function wakeAgentContent(effect: WakeAgentEffect): string {
  // Old outbox rows intentionally retain the legacy projection. New rows carry
  // the immutable rendered packet captured in process-inbox's commit transaction.
  return effect.renderedContent ?? canonicalize({
    actionId: effect.actionId,
    workItemRevision: effect.actionWorkItemRevision,
    targetDigest: effect.targetDigest,
    packetDigest: effect.packetDigest
  })
}

export const CATSCO_OPENCLI_TRANSPORT_VERSION = 'catsco-opencli-p0-v1'

export function wakeAgentPostcondition(ownerUid: string, effect: WakeAgentEffect) {
  const contentDigest = sha256(wakeAgentContent(effect))
  const identity = canonicalize({
    transportVersion: CATSCO_OPENCLI_TRANSPORT_VERSION,
    ownerUid,
    targetTopicId: effect.targetTopicId,
    effectKey: effect.effectKey,
    contentDigest
  })
  return {
    transportVersion: CATSCO_OPENCLI_TRANSPORT_VERSION,
    ownerUid,
    targetTopicId: effect.targetTopicId,
    effectKey: effect.effectKey,
    contentDigest,
    clientMsgId: `loopctl:${sha256(identity)}`
  }
}

export const capabilities = {
  catsco_read: 'bounded-topic-polling',
  catsco_existing_topic_send: 'available-idempotent',
  catsco_receipt_reconciliation: 'single-machine-local-registry-plus-server-seq-confirmation',
  automatic_task_creation: 'blocked',
  runtime_wrapper: 'unavailable',
  reviewer_authority: 'unavailable',
  artifact_write: 'unavailable',
  parallel_attempts: 'unavailable'
} as const
