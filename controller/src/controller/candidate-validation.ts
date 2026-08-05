import type { SqliteDatabase } from '../store/sqlite.js'
import type { CandidateValidatedEvent, IngressEvent, TrustedEvidence } from '../protocol/events.js'
import type { RuntimeProofAdapter } from '../adapters/runtime.js'
import type { GitHubReadAdapter } from '../adapters/github.js'
import { loadSnapshot } from '../store/repositories.js'
import { canonicalize } from '../lib/canonical-json.js'
import { digestJson } from '../lib/digest.js'
import { parseCatscoAttestation } from './ingest.js'

export class CandidateRejection extends Error { constructor(readonly code: string, message = code) { super(message) } }
const allowed = (path: string, scopes: string[]) => scopes.some(scope => scope === path || (scope.endsWith('/**') && path.startsWith(scope.slice(0,-2))) || (scope.endsWith('/') && path.startsWith(scope)))
export async function validateCandidate(db: SqliteDatabase, ownerUid: string, row: Record<string,unknown>, event: Extract<IngressEvent,{type:'candidate_submitted'}>, runtime: RuntimeProofAdapter, github: GitHubReadAdapter): Promise<CandidateValidatedEvent> {
  const snapshot = loadSnapshot(db,ownerUid,event.payload.workItemId); const work=snapshot.workItem; const attempt=snapshot.attempt
  if (!work) throw new CandidateRejection('work_item_not_found')
  if (!attempt || attempt.attemptId!==event.payload.attemptId) throw new CandidateRejection('attempt_mismatch')
  if (work.revision!==event.payload.workItemRevision) throw new CandidateRejection('stale_work_item_revision')
  if (attempt.generation!==event.payload.generation) throw new CandidateRejection('stale_generation')
  if (event.payload.deliverable.repository!==work.githubRepo) throw new CandidateRejection('github_repository_mismatch')
  const attestation = parseCatscoAttestation(row)
  try {
    await runtime.verify(ownerUid, event.payload, attempt, {
      trustedIngressAt: String(row.trusted_ingress_at),
      expectedWorkerTopicId: work.workerTopicId,
      ...(attestation ? { attestation } : {})
    })
  } catch(error) { throw new CandidateRejection('runtime_proof_invalid', error instanceof Error?error.message:String(error)) }
  const observed = await github.readPullRequest(event.payload.deliverable.repository,event.payload.deliverable.prNumber)
  if (observed.repository!==work.githubRepo || observed.headSha!==event.payload.deliverable.headSha || observed.baseSha!==event.payload.deliverable.baseSha) throw new CandidateRejection('github_evidence_mismatch')
  if (observed.changedPaths.some(path=>!allowed(path,work.writeScope))) throw new CandidateRejection('write_scope_violation')
  const evidenceBody = { repository: observed.repository, prNumber: observed.prNumber, headSha: observed.headSha,
    baseSha: observed.baseSha, changedPaths: [...observed.changedPaths].sort() }
  const evidence: TrustedEvidence={...evidenceBody,digest:digestJson(evidenceBody)}
  const validation={kind:'candidate_validated',evidence,evidenceDigest:evidence.digest}
  db.prepare(`UPDATE inbox SET validation_receipt_json=? WHERE owner_uid=? AND inbox_id=? AND status='pending' AND validation_receipt_json IS NULL`).run(canonicalize(validation),ownerUid,row.inbox_id)
  return { type:'candidate_validated',eventId:event.eventId,ingressSequence:Number(row.ingress_sequence),trustedIngressAt:String(row.trusted_ingress_at),payload:event.payload,evidence }
}
