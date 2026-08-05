import type { SqliteDatabase } from '../store/sqlite.js'
import { canonicalize } from '../lib/canonical-json.js'
import { digestJson } from '../lib/digest.js'

export const ACTION_PACKET_SCHEMA = 'loopctl-action-packet-v1'

type Row = Record<string, unknown>
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T

function actionRow(db: SqliteDatabase, ownerUid: string, actionId: string): Row {
  const row = db.prepare(`SELECT a.*,w.state work_state,w.loop_id,w.profile_id,w.terminal_state,
    w.task_contract_hash,w.reference_snapshot_hash,w.write_scope_json,w.write_scope_hash,
    w.acceptance_contract_hash,w.github_repo,w.catsco_project_id,w.worker_topic_id,
    w.steward_topic_id,w.steward_principal,
    at.attempt_id,at.work_item_revision attempt_work_item_revision,at.attempt_number,at.generation,
    at.control_state,at.reported_state,at.connection_state,at.runtime_principal,at.proof_mode,
    at.proof_key_id,at.proof_public_key,at.lease_expires_at,at.work_bundle_json,
    c.candidate_id,c.attempt_id candidate_attempt_id,c.generation candidate_generation,
    c.deliverable_json,c.deliverable_digest,c.trusted_evidence_json
    FROM actions a JOIN work_items w ON w.owner_uid=a.owner_uid AND w.work_item_id=a.work_item_id
    LEFT JOIN attempts at ON at.owner_uid=a.owner_uid AND at.work_item_id=a.work_item_id
      AND at.generation=(SELECT MAX(generation) FROM attempts WHERE owner_uid=a.owner_uid AND work_item_id=a.work_item_id)
    LEFT JOIN candidates c ON c.owner_uid=a.owner_uid AND c.work_item_id=a.work_item_id
      AND c.ingress_sequence=(SELECT MAX(ingress_sequence) FROM candidates WHERE owner_uid=a.owner_uid AND work_item_id=a.work_item_id)
    WHERE a.owner_uid=? AND a.action_id=?`).get(ownerUid, actionId) as Row | undefined
  if (!row) throw new Error(`action not found: ${actionId}`)
  const allowed = (row.kind === 'execute_attempt' && row.work_state === 'assigned') ||
    (row.kind === 'review_candidate' && row.work_state === 'candidate') ||
    (row.kind === 'plan_next' && (row.work_state === 'accepted' || row.work_state === 'closed'))
  if (!['ready', 'satisfied'].includes(String(row.state)) || !allowed || Number(row.work_item_revision) !== Number(row.work_state === 'assigned' ? row.attempt_work_item_revision : row.work_item_revision)) {
    throw new Error('stale action projection: action state, revision, or target state changed')
  }
  return row
}

function common(row: Row) {
  return {
    actionId: String(row.action_id), actionKey: String(row.action_key), action: {
      id: String(row.action_id), key: String(row.action_key), kind: String(row.kind), state: String(row.state),
      workItemRevision: Number(row.work_item_revision), targetPrincipal: String(row.target_principal),
      targetTopicId: String(row.target_topic_id), targetDigest: String(row.target_digest)
    },
    workItemId: String(row.work_item_id), workItemRevision: Number(row.work_item_revision),
    targetPrincipal: String(row.target_principal), targetTopicId: String(row.target_topic_id),
    targetDigest: String(row.target_digest),
    contracts: {
      taskContractHash: String(row.task_contract_hash), referenceSnapshotHash: String(row.reference_snapshot_hash),
      writeScopeHash: String(row.write_scope_hash), acceptanceContractHash: String(row.acceptance_contract_hash)
    }
  }
}

function render(row: Row): Record<string, unknown> {
  const base = common(row)
  if (row.kind === 'execute_attempt') {
    const packet = {
      kind: 'execute_attempt', schema: ACTION_PACKET_SCHEMA, ...base,
      loopId: String(row.loop_id), profileId: String(row.profile_id),
      workerTopicId: String(row.worker_topic_id), githubRepo: String(row.github_repo),
      writeScope: json(row.write_scope_json),
      attemptId: String(row.attempt_id), attemptNumber: Number(row.attempt_number), generation: Number(row.generation),
      runtimePrincipal: String(row.runtime_principal), leaseExpiresAt: String(row.lease_expires_at),
      proofMode: String(row.proof_mode),
      ...(String(row.proof_key_id) ? { proofKeyId: String(row.proof_key_id) } : {}),
      ...(String(row.proof_public_key) ? { proofPublicKey: String(row.proof_public_key) } : {}),
      workBundle: json(row.work_bundle_json)
    }
    return { ...packet, packetDigest: digestJson(packet) }
  }
  if (row.kind === 'review_candidate') {
    const candidate = row.candidate_id ? {
      candidateId: String(row.candidate_id), attemptId: String(row.candidate_attempt_id), generation: Number(row.candidate_generation),
      deliverable: json(row.deliverable_json), digest: String(row.deliverable_digest), trustedEvidence: json(row.trusted_evidence_json)
    } : null
    const packet = {
      kind: 'review_candidate', schema: ACTION_PACKET_SCHEMA, ...base,
      loopId: String(row.loop_id), profileId: String(row.profile_id), githubRepo: String(row.github_repo),
      stewardPrincipal: String(row.steward_principal),
      stewardTopicId: String(row.steward_topic_id), acceptanceContractHash: String(row.acceptance_contract_hash), candidate
    }
    return { ...packet, packetDigest: digestJson(packet) }
  }
  const packet = {
    kind: 'plan_next', schema: ACTION_PACKET_SCHEMA, ...base,
    loopId: String(row.loop_id), profileId: String(row.profile_id), terminalState: String(row.terminal_state),
    completedWorkItem: { workItemId: String(row.work_item_id), revision: Number(row.work_item_revision), state: String(row.work_state) },
    currentCandidate: row.candidate_id ? {
      candidateId: String(row.candidate_id), deliverable: json(row.deliverable_json), digest: String(row.deliverable_digest),
      trustedEvidence: json(row.trusted_evidence_json)
    } : null,
    outcomeContext: { actionState: String(row.state), targetDigest: String(row.target_digest), acceptanceContractHash: String(row.acceptance_contract_hash) }
  }
  return { ...packet, packetDigest: digestJson(packet) }
}

export function renderActionPacket(db: SqliteDatabase, ownerUid: string, actionId: string): string {
  return canonicalize(render(actionRow(db, ownerUid, actionId)))
}

export function actionPacket(db: SqliteDatabase, ownerUid: string, actionId: string): Record<string, unknown> {
  return JSON.parse(renderActionPacket(db, ownerUid, actionId)) as Record<string, unknown>
}

export function packetForWorkItem(db: SqliteDatabase, ownerUid: string, workItemId: string): Record<string, unknown> {
  const row = db.prepare(`SELECT action_id FROM actions WHERE owner_uid=? AND work_item_id=? AND state='ready'
    ORDER BY created_at,action_id LIMIT 1`).get(ownerUid, workItemId) as { action_id: string } | undefined
  if (!row) throw new Error(`ready action not found for work item: ${workItemId}`)
  return actionPacket(db, ownerUid, row.action_id)
}
