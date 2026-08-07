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
export const CATSCO_OPENCLI_GROUP_TRANSPORT_VERSION = 'catsco-opencli-group-v2'

export function wakeAgentMention(effect: WakeAgentEffect): string | undefined {
  if (!effect.targetTopicId.startsWith('grp_')) return undefined
  const match = /^catsco-user:([1-9]\d*)$/.exec(effect.targetPrincipal)
  if (!match) throw new Error('group Action requires a numeric CatsCo target principal')
  return `usr${match[1]}`
}

export function wakeAgentPostcondition(ownerUid: string, effect: WakeAgentEffect) {
  const contentDigest = sha256(wakeAgentContent(effect))
  const targetMention = wakeAgentMention(effect)
  const transportVersion = targetMention
    ? CATSCO_OPENCLI_GROUP_TRANSPORT_VERSION
    : CATSCO_OPENCLI_TRANSPORT_VERSION
  const identity = canonicalize({
    transportVersion,
    ownerUid,
    targetTopicId: effect.targetTopicId,
    effectKey: effect.effectKey,
    contentDigest,
    ...(targetMention ? { targetMention } : {})
  })
  return {
    transportVersion,
    ownerUid,
    targetTopicId: effect.targetTopicId,
    effectKey: effect.effectKey,
    contentDigest,
    ...(targetMention ? { targetMention } : {}),
    clientMsgId: `loopctl:${sha256(identity)}`
  }
}

export const capabilities = {
  catsco_read: 'bounded-topic-polling',
  catsco_existing_topic_send: 'available-idempotent',
  catsco_receipt_reconciliation: 'single-machine-local-registry-plus-server-seq-confirmation',
  automatic_task_creation: 'blocked',
  runtime_wrapper: 'not_controller_managed',
  reviewer_authority: 'not_controller_managed',
  artifact_write: 'not_controller_managed',
  parallel_attempts: 'available_via_dedicated_agent_task_topics'
} as const
