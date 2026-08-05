import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CatscoReviewerAuthorityAdapter, UnavailableReviewerAuthorityAdapter } from '../src/adapters/reviewer.js'
import { Ed25519RuntimeProofAdapter, runtimeProofPayload } from '../src/adapters/runtime-ed25519.js'
import { ExplicitRuntimeProofAdapter } from '../src/adapters/runtime-explicit.js'
import { ingest } from '../src/controller/ingest.js'
import { processPending, type ProcessingAdapters } from '../src/controller/process-inbox.js'
import { digestJson } from '../src/lib/digest.js'
import { loadSnapshot } from '../src/store/repositories.js'
import { initializeOwner, migrate } from '../src/store/migrate.js'
import { openDatabase, type SqliteDatabase } from '../src/store/sqlite.js'
import type { CandidatePacket } from '../src/protocol/events.js'

const dirs: string[] = []
const now = '2026-08-04T00:00:00.000Z'
const serverTime = '2026-08-04T00:03:00.000Z'
const hashes = {
  taskContractHash: 'task-hash-0001', referenceSnapshotHash: 'ref-hash-00001',
  writeScopeHash: 'scope-hash-001', acceptanceContractHash: 'accept-hash-01'
}
const deliverableBody = { kind: 'github_pr' as const, repository: 'acme/repo', prNumber: 7, headSha: 'head-123', baseSha: 'base-123' }
const deliverableDigest = digestJson(deliverableBody)
const providers = { now: () => now, id: (prefix: string) => `${prefix}-${Math.random()}` }
const attestation = (topicId: string, senderUid: string, receivedAt = serverTime, seqId = '41') => ({
  topicId, seqId, senderUid, serverReceivedAt: receivedAt
})
const envelope = (type: string, key: string, payload: unknown) => ({
  type, eventId: `event-${key}`, idempotencyKey: key, source: 'catsco', entityRef: 'work_item:wi-1', payload
})

function database(): SqliteDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'loopctl-authority-'))
  dirs.push(dir)
  const db = openDatabase(join(dir, 'loop.db'))
  migrate(db)
  initializeOwner(db, 'owner-a', now)
  return db
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function registration() {
  return envelope('work_item_registered', 'register', {
    workItemId: 'wi-1', loopId: 'loop-1', profileId: 'product@1', terminalState: 'accepted', ...hashes,
    writeScope: ['src/**'], githubRepo: 'acme/repo', catscoProjectId: 'project-1',
    workerTopicId: 'worker-topic', stewardTopicId: 'steward-topic', stewardPrincipal: 'catsco-user:574'
  })
}
function catscoBundle(leaseExpiresAt = '2026-08-05T00:00:00.000Z') {
  return envelope('work_bundle_proposed', 'bundle', {
    workItemId: 'wi-1', expectedRevision: 1, attemptId: 'attempt-1', attemptNumber: 1, generation: 1,
    runtimePrincipal: 'catsco-user:559', proofMode: 'catsco-message', leaseExpiresAt,
    workBundle: { contractDigest: 'bundle-digest-1', instructions: 'work', deliverables: ['pull request'] }, ...hashes
  })
}
function started() {
  return envelope('runtime_started', 'started', {
    workItemId: 'wi-1', expectedRevision: 2, attemptId: 'attempt-1', generation: 1,
    runtimePrincipal: 'catsco-user:559', signature: 'catsco-message-attested'
  })
}
function candidate(overrides: Record<string, unknown> = {}, key = 'candidate') {
  return envelope('candidate_submitted', key, {
    ownerUid: 'owner-a', workItemId: 'wi-1', workItemRevision: 3, attemptId: 'attempt-1', generation: 1,
    runtimePrincipal: 'catsco-user:559', proofMode: 'catsco-message', candidateId: 'candidate-1',
    deliverable: { ...deliverableBody, digest: deliverableDigest }, ...hashes, ...overrides
  })
}
function review(overrides: Record<string, unknown> = {}, key = 'review') {
  return envelope('review_decided', key, {
    workItemId: 'wi-1', expectedRevision: 4, candidateId: 'candidate-1', outcome: 'accepted',
    reviewerPrincipal: 'catsco-user:574', reviewedHeadSha: 'head-123',
    reviewedDeliverableDigest: deliverableDigest, acceptanceContractHash: hashes.acceptanceContractHash,
    ...overrides
  })
}

const github = { readPullRequest: async () => ({
  repository: 'acme/repo', prNumber: 7, headSha: 'head-123', baseSha: 'base-123',
  changedPaths: ['src/fix.ts'], state: 'open' as const, merged: false
}) }
const adapters: ProcessingAdapters = {
  runtime: new ExplicitRuntimeProofAdapter(new Ed25519RuntimeProofAdapter()), github,
  reviewer: new CatscoReviewerAuthorityAdapter(new UnavailableReviewerAuthorityAdapter())
}
async function reachInProgress(db: SqliteDatabase, leaseExpiresAt?: string) {
  ingest(db, 'owner-a', registration(), providers)
  ingest(db, 'owner-a', catscoBundle(leaseExpiresAt), providers)
  ingest(db, 'owner-a', started(), providers, attestation('worker-topic', '559'))
  await processPending(db, 'owner-a', adapters)
}
async function reachCandidate(db: SqliteDatabase) {
  await reachInProgress(db)
  ingest(db, 'owner-a', candidate(), providers, attestation('worker-topic', '559'))
  await processPending(db, 'owner-a', adapters)
}

describe('canonical CatsCo transport attestation', () => {
  it('stores sender/topic separately from content and binds identifier conflicts to the attestation', () => {
    const db = database()
    const event = registration()
    ingest(db, 'owner-a', event, providers, attestation('worker-topic', '559'))
    const row = db.prepare('SELECT raw_json,catsco_attestation_json,catsco_attestation_digest FROM inbox').get() as Record<string, unknown>
    expect(JSON.parse(String(row.raw_json))).not.toHaveProperty('senderUid')
    expect(JSON.parse(String(row.catsco_attestation_json))).toEqual(attestation('worker-topic', '559'))
    expect(row.catsco_attestation_digest).toBeTruthy()

    const conflict = ingest(db, 'owner-a', event, providers, attestation('other-topic', '574'))
    expect(conflict).toMatchObject({ status: 'rejected', rejectionCode: 'identifier_conflict' })
    expect(db.prepare('SELECT count(*) count FROM ingress_conflicts').get()).toEqual({ count: 1 })
    db.close()
  })

  it('leaves manual CLI-style ingest unattested', () => {
    const db = database()
    ingest(db, 'owner-a', registration(), providers)
    expect(db.prepare('SELECT catsco_attestation_json,catsco_attestation_digest FROM inbox').get())
      .toEqual({ catsco_attestation_json: null, catsco_attestation_digest: null })
    db.close()
  })
})

describe('explicit runtime proof modes', () => {
  it('accepts an exact Candidate from the enrolled worker sender/topic in CatsCo-message mode', async () => {
    const db = database()
    await reachCandidate(db)
    expect(loadSnapshot(db, 'owner-a', 'wi-1').workItem?.state).toBe('candidate')
    expect(db.prepare('SELECT proof_mode FROM attempts').get()).toEqual({ proof_mode: 'catsco-message' })
    db.close()
  })

  it.each([
    ['wrong sender', attestation('worker-topic', '574'), undefined],
    ['wrong topic', attestation('steward-topic', '559'), undefined],
    ['expired lease', attestation('worker-topic', '559', serverTime), '2026-08-04T00:02:00.000Z']
  ])('rejects %s without a Candidate', async (_name, observed, lease) => {
    const db = database()
    await reachInProgress(db, lease)
    ingest(db, 'owner-a', candidate(), providers, observed)
    const [receipt] = await processPending(db, 'owner-a', adapters)
    expect(receipt).toMatchObject({ status: 'rejected' })
    expect(db.prepare('SELECT count(*) count FROM candidates').get()).toEqual({ count: 0 })
    db.close()
  })

  it('keeps backwards-compatible Ed25519 mode authoritative', async () => {
    const db = database()
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    ingest(db, 'owner-a', registration(), providers)
    ingest(db, 'owner-a', envelope('work_bundle_proposed', 'bundle-ed', {
      workItemId: 'wi-1', expectedRevision: 1, attemptId: 'attempt-1', attemptNumber: 1, generation: 1,
      runtimePrincipal: 'catsco-user:runtime-ed', proofKeyId: 'key-ed', proofPublicKey: publicPem,
      leaseExpiresAt: '2026-08-05T00:00:00.000Z',
      workBundle: { contractDigest: 'bundle-digest-ed', instructions: 'work', deliverables: ['pull request'] }, ...hashes
    }), providers)
    ingest(db, 'owner-a', envelope('runtime_started', 'started-ed', {
      workItemId: 'wi-1', expectedRevision: 2, attemptId: 'attempt-1', generation: 1,
      runtimePrincipal: 'catsco-user:runtime-ed', signature: 'catsco-message-attested'
    }), providers, attestation('worker-topic', 'runtime-ed'))
    await processPending(db, 'owner-a', adapters)
    const unsigned: CandidatePacket = {
      ownerUid: 'owner-a', workItemId: 'wi-1', workItemRevision: 3, attemptId: 'attempt-1', generation: 1,
      runtimePrincipal: 'catsco-user:runtime-ed', candidateId: 'candidate-1',
      deliverable: { ...deliverableBody, digest: deliverableDigest }, ...hashes, signature: 'pending'
    }
    unsigned.signature = sign(null, Buffer.from(runtimeProofPayload(unsigned)), privateKey).toString('base64')
    ingest(db, 'owner-a', envelope('candidate_submitted', 'candidate-ed', unsigned), providers)
    const [receipt] = await processPending(db, 'owner-a', adapters)
    expect(receipt).toMatchObject({ status: 'committed', candidateId: 'candidate-1' })
    expect(db.prepare('SELECT proof_mode FROM attempts').get()).toEqual({ proof_mode: 'ed25519' })
    db.close()
  })
})

describe('CatsCo Steward review authority', () => {
  it('accepts only the stored Steward principal on the Steward topic', async () => {
    const db = database()
    await reachCandidate(db)
    ingest(db, 'owner-a', review(), providers, attestation('steward-topic', '574', serverTime, '42'))
    const [receipt] = await processPending(db, 'owner-a', adapters)
    expect(receipt).toMatchObject({ status: 'committed' })
    expect(loadSnapshot(db, 'owner-a', 'wi-1').workItem?.state).toBe('accepted')
    db.close()
  })

  it.each([
    ['forged reviewerPrincipal', review({ reviewerPrincipal: 'catsco-user:999' }, 'review-forged'), attestation('steward-topic', '574')],
    ['wrong Steward sender', review({}, 'review-wrong-sender'), attestation('steward-topic', '999')],
    ['wrong Steward topic', review({}, 'review-wrong-topic'), attestation('worker-topic', '574')]
  ])('rejects %s', async (_name, decision, observed) => {
    const db = database()
    await reachCandidate(db)
    ingest(db, 'owner-a', decision, providers, observed)
    const [receipt] = await processPending(db, 'owner-a', adapters)
    expect(receipt).toMatchObject({ status: 'rejected', rejectionCode: 'reviewer_authentication_invalid' })
    expect(loadSnapshot(db, 'owner-a', 'wi-1').workItem?.state).toBe('candidate')
    db.close()
  })
})

it('migrates a populated previous-schema database with Ed25519 defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loopctl-v3-smoke-'))
  dirs.push(dir)
  const db = openDatabase(join(dir, 'loop.db'))
  for (const version of [1, 2, 3]) {
    const file = version === 1 ? '001_initial.sql' : version === 2 ? '002_fencing_and_conflicts.sql' : '003_outbox_transport_identity.sql'
    db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
    db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(version, now)
  }
  initializeOwner(db, 'owner-a', now)
  migrate(db)
  expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 4 })
  expect(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='inbox'").get()).toBeTruthy()
  db.close()
})
