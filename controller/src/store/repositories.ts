import type { SqliteDatabase } from './sqlite.js'
import type { AttemptSnapshot, CandidateSnapshot, KernelSnapshot, WorkItemSnapshot } from '../kernel/types.js'

const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T
export function loadSnapshot(db: SqliteDatabase, ownerUid: string, workItemId: string): KernelSnapshot {
  const w = db.prepare('SELECT * FROM work_items WHERE owner_uid=? AND work_item_id=?').get(ownerUid, workItemId) as Record<string, unknown> | undefined
  if (!w) return { ownerUid, workItem: null, attempt: null, candidate: null }
  const a = db.prepare('SELECT * FROM attempts WHERE owner_uid=? AND work_item_id=? ORDER BY generation DESC LIMIT 1').get(ownerUid, workItemId) as Record<string, unknown> | undefined
  const c = db.prepare('SELECT * FROM candidates WHERE owner_uid=? AND work_item_id=? ORDER BY ingress_sequence DESC LIMIT 1').get(ownerUid, workItemId) as Record<string, unknown> | undefined
  const workItem: WorkItemSnapshot = {
    workItemId: String(w.work_item_id), revision: Number(w.revision), state: w.state as WorkItemSnapshot['state'], loopId: String(w.loop_id), profileId: String(w.profile_id), terminalState: w.terminal_state as WorkItemSnapshot['terminalState'],
    taskContractHash: String(w.task_contract_hash), referenceSnapshotHash: String(w.reference_snapshot_hash), writeScope: parse<string[]>(w.write_scope_json), writeScopeHash: String(w.write_scope_hash), acceptanceContractHash: String(w.acceptance_contract_hash), githubRepo: String(w.github_repo), catscoProjectId: String(w.catsco_project_id), workerTopicId: String(w.worker_topic_id), stewardTopicId: String(w.steward_topic_id), stewardPrincipal: String(w.steward_principal)
  }
  const attempt: AttemptSnapshot | null = a ? {
    attemptId: String(a.attempt_id), workItemId: String(a.work_item_id), workItemRevision: Number(a.work_item_revision), attemptNumber: Number(a.attempt_number), generation: Number(a.generation),
    controlState: String(a.control_state), reportedState: String(a.reported_state), connectionState: String(a.connection_state), runtimePrincipal: String(a.runtime_principal), proofMode: a.proof_mode as AttemptSnapshot['proofMode'],
    ...(String(a.proof_key_id) ? { proofKeyId: String(a.proof_key_id) } : {}),
    ...(String(a.proof_public_key) ? { proofPublicKey: String(a.proof_public_key) } : {}),
    leaseExpiresAt: String(a.lease_expires_at), taskContractHash: String(a.task_contract_hash), referenceSnapshotHash: String(a.reference_snapshot_hash), writeScopeHash: String(a.write_scope_hash), acceptanceContractHash: String(a.acceptance_contract_hash), workBundle: parse(a.work_bundle_json)
  } : null
  const candidate: CandidateSnapshot | null = c ? {
    candidateId: String(c.candidate_id), attemptId: String(c.attempt_id), generation: Number(c.generation),
    workItemId: String(c.work_item_id), workItemRevision: Number(c.work_item_revision),
    deliverable: parse(c.deliverable_json), evidence: parse(c.trusted_evidence_json)
  } : null
  return { ownerUid, workItem, attempt, candidate }
}
export function statusRows(db: SqliteDatabase, ownerUid: string) {
  const namespace = db.prepare('SELECT ledger_revision FROM owner_namespaces WHERE owner_uid=?').get(ownerUid) as {ledger_revision:number}
  const counts = (table: string) => db.prepare(`SELECT status, count(*) count FROM ${table} WHERE owner_uid=? GROUP BY status`).all(ownerUid)
  return {
    ownerUid, ledgerRevision: namespace.ledger_revision,
    inbox: counts('inbox'),
    ingressConflicts: db.prepare('SELECT count(*) count FROM ingress_conflicts WHERE owner_uid=?').get(ownerUid),
    outbox: db.prepare('SELECT state status,count(*) count FROM outbox WHERE owner_uid=? GROUP BY state').all(ownerUid),
    workItems: db.prepare('SELECT work_item_id workItemId,revision,state,profile_id profileId FROM work_items WHERE owner_uid=? ORDER BY work_item_id').all(ownerUid),
    attempts: db.prepare('SELECT attempt_id attemptId,work_item_id workItemId,generation,control_state controlState,reported_state reportedState,connection_state connectionState FROM attempts WHERE owner_uid=?').all(ownerUid),
    candidates: db.prepare('SELECT candidate_id candidateId,work_item_id workItemId,work_item_revision workItemRevision FROM candidates WHERE owner_uid=?').all(ownerUid),
    actions: db.prepare('SELECT action_id actionId,action_key actionKey,kind,state,work_item_id workItemId,work_item_revision workItemRevision FROM actions WHERE owner_uid=?').all(ownerUid)
  }
}
