import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SqliteDatabase } from '../src/store/sqlite.js'
import { openDatabase } from '../src/store/sqlite.js'
import { initializeOwner, migrate } from '../src/store/migrate.js'
import { ingest, type Providers } from '../src/controller/ingest.js'
import { processPending, type ProcessingAdapters } from '../src/controller/process-inbox.js'
import { loadSnapshot } from '../src/store/repositories.js'
import { digestJson, sha256 } from '../src/lib/digest.js'
import { runOutbox } from '../src/controller/outbox.js'
import type { CatscoAdapter, CatscoMessageReceipt } from '../src/adapters/catsco.js'
import { decide } from '../src/kernel/decide.js'
import { reconcile } from '../src/controller/reconcile.js'
import { LocalPilotCatscoAdapter } from '../src/adapters/catsco-local-pilot.js'

const dirs: string[] = []
const now = '2026-08-04T00:00:00.000Z'
const later = '2026-08-04T01:00:00.000Z'
const hashes = {
  taskContractHash: 'task-hash-0001', referenceSnapshotHash: 'ref-hash-00001',
  writeScopeHash: 'scope-hash-001', acceptanceContractHash: 'accept-hash-01'
}
const providers: Providers = { now: () => now, id: prefix => `${prefix}-fixed` }

function database(owners = ['owner-a']): { db: SqliteDatabase; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'loopctl-'))
  dirs.push(dir)
  const path = join(dir, 'loop.db')
  const db = openDatabase(path)
  migrate(db)
  for (const owner of owners) initializeOwner(db, owner, now)
  return { db, path }
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const envelope = (type: string, key: string, payload: unknown) => ({
  type, eventId: `event-${key}`, idempotencyKey: key, source: 'test', entityRef: 'work_item:wi-1', payload
})
const registration = (key = 'register', terminalState: 'accepted' | 'closed' = 'accepted', workItemId = 'wi-1') => envelope('work_item_registered', key, {
  workItemId, loopId: 'loop-1', profileId: 'product@1', terminalState, ...hashes,
  writeScope: ['src/**', 'tests/**'], githubRepo: 'acme/repo', catscoProjectId: 'project-1',
  workerTopicId: 'worker-topic', stewardTopicId: 'steward-topic'
})
const bundle = (expectedRevision = 1, generation = 1, attemptId = `attempt-${generation}`, key = `bundle-${generation}`) =>
  envelope('work_bundle_proposed', key, {
    workItemId: 'wi-1', expectedRevision, attemptId, attemptNumber: generation, generation,
    runtimePrincipal: `catsco-user:${generation}`, proofKeyId: `key-${generation}`, proofPublicKey: 'unused-in-fake',
    leaseExpiresAt: '2026-08-05T00:00:00.000Z',
    workBundle: { contractDigest: `bundle-digest-${generation}`, instructions: 'do bounded work', deliverables: ['pull request'] },
    ...hashes
  })
const started = (expectedRevision = 2, generation = 1, attemptId = `attempt-${generation}`, key = `started-${generation}`) =>
  envelope('runtime_started', key, {
    workItemId: 'wi-1', expectedRevision, attemptId, generation,
    runtimePrincipal: `catsco-user:${generation}`, signature: 'catsco-message-attested'
  })

const deliverableBody = { kind: 'github_pr' as const, repository: 'acme/repo', prNumber: 7, headSha: 'head-123', baseSha: 'base-123' }
const deliverableDigest = digestJson(deliverableBody)
function candidate(overrides: Record<string, unknown> = {}, key = 'candidate-1') {
  return envelope('candidate_submitted', key, {
    ownerUid: 'owner-a', workItemId: 'wi-1', workItemRevision: 3, attemptId: 'attempt-1', generation: 1,
    runtimePrincipal: 'catsco-user:1', candidateId: 'candidate-1', deliverable: { ...deliverableBody, digest: deliverableDigest },
    ...hashes, signature: 'fake-signature', ...overrides
  })
}

function fakeAdapters(options: { headSha?: string; state?: 'open' | 'closed'; merged?: boolean; reviewerValid?: boolean } = {}): ProcessingAdapters {
  return {
    runtime: { verify: async () => undefined },
    github: { readPullRequest: async (repository, prNumber) => ({
      repository, prNumber, headSha: options.headSha ?? 'head-123', baseSha: 'base-123',
      changedPaths: ['src/fix.ts', 'tests/fix.test.ts'], state: options.state ?? 'open', merged: options.merged ?? false
    }) },
    reviewer: { verify: async (_owner, decision) => {
      if (options.reviewerValid === false || decision.reviewerProof !== 'valid-review-proof') throw new Error('invalid reviewer proof')
      return { authenticatedPrincipal: decision.reviewerPrincipal, receiptDigest: 'authenticated-review-receipt' }
    } }
  }
}
const adapters = fakeAdapters()

const reviewDecision = (outcome: 'accepted' | 'changes_requested', key: string, overrides: Record<string, unknown> = {}) =>
  envelope('review_decided', key, {
    workItemId: 'wi-1', expectedRevision: 4, candidateId: 'candidate-1', outcome,
    reviewerPrincipal: 'steward', authenticationRef: 'catsco:event:review-1', reviewerProof: 'valid-review-proof',
    reviewedHeadSha: 'head-123', reviewedDeliverableDigest: deliverableDigest,
    acceptanceContractHash: hashes.acceptanceContractHash, ...overrides
  })

async function process(db: SqliteDatabase, owner = 'owner-a', selected = adapters) { return processPending(db, owner, selected) }
async function reachInProgress(db: SqliteDatabase, terminalState: 'accepted' | 'closed' = 'accepted') {
  ingest(db, 'owner-a', registration('register', terminalState), providers)
  ingest(db, 'owner-a', bundle(), { ...providers, id: prefix => `${prefix}-bundle` })
  ingest(db, 'owner-a', started(), { ...providers, id: prefix => `${prefix}-started` }, {
    topicId: 'worker-topic', seqId: '1', senderUid: '1', serverReceivedAt: later
  })
  await process(db)
}
async function reachCandidate(db: SqliteDatabase, terminalState: 'accepted' | 'closed' = 'accepted') {
  await reachInProgress(db, terminalState)
  ingest(db, 'owner-a', candidate(), { ...providers, id: prefix => `${prefix}-candidate` })
  await process(db)
}

it('durably rejects non-addressable group principals without blocking later inbox rows', async () => {
  const { db } = database()
  const invalidRegistration = registration()
  invalidRegistration.payload.workerTopicId = 'grp_1400'
  invalidRegistration.payload.stewardTopicId = 'grp_1400'
  invalidRegistration.payload.stewardPrincipal = 'steward'
  ingest(db, 'owner-a', invalidRegistration, providers)
  ingest(db, 'owner-a', registration('register-after-invalid', 'accepted', 'wi-2'), { ...providers, id: prefix => `${prefix}-later` })
  const receipts = await process(db)
  expect(receipts).toHaveLength(2)
  expect(receipts[0]).toMatchObject({ status: 'rejected', rejectionCode: 'invalid_group_target_principal' })
  expect(receipts[1]).toMatchObject({ status: 'committed' })
  expect(db.prepare("SELECT status FROM inbox WHERE event_id='event-register'").get()).toEqual({ status: 'rejected' })
  db.close()
})

it('durably rejects a group bundle with a non-addressable Worker principal', async () => {
  const { db } = database()
  const groupRegistration = registration()
  groupRegistration.payload.workerTopicId = 'grp_1400'
  groupRegistration.payload.stewardTopicId = 'grp_1400'
  groupRegistration.payload.stewardPrincipal = 'catsco-user:574'
  ingest(db, 'owner-a', groupRegistration, providers)
  const badBundle = bundle()
  badBundle.payload.runtimePrincipal = 'runtime-1'
  ingest(db, 'owner-a', badBundle, { ...providers, id: prefix => `${prefix}-bad-bundle` })
  const receipts = await process(db)
  expect(receipts[1]).toMatchObject({ status: 'rejected', rejectionCode: 'invalid_group_target_principal' })
  expect(db.prepare('SELECT count(*) count FROM outbox').get()).toEqual({ count: 0 })
  db.close()
})

it('loads only package-relative migrations from an unrelated working directory', () => {
  const unrelated = mkdtempSync(join(tmpdir(), 'loopctl-unrelated-cwd-'))
  dirs.push(unrelated)
  mkdirSync(join(unrelated, 'migrations'))
  writeFileSync(join(unrelated, 'migrations', '001_malicious.sql'), 'CREATE TABLE malicious(value TEXT);')
  const originalCwd = globalThis.process.cwd()
  let db: SqliteDatabase | undefined
  try {
    globalThis.process.chdir(unrelated)
    db = openDatabase(join(unrelated, 'state', 'loop.db'))
    migrate(db)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'").get()).toBeTruthy()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='malicious'").get()).toBeUndefined()
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }])
  } finally {
    db?.close()
    globalThis.process.chdir(originalCwd)
  }
})

it('isolates identical owner-local keys and rows', async () => {
  const { db } = database(['owner-a', 'owner-b'])
  const a = ingest(db, 'owner-a', registration('same-key'), providers)
  const b = ingest(db, 'owner-b', registration('same-key'), { ...providers, id: prefix => `${prefix}-b` })
  expect(a.ingressSequence).toBe(1)
  expect(b.ingressSequence).toBe(1)
  await process(db, 'owner-a')
  await process(db, 'owner-b')
  ingest(db, 'owner-a', bundle(), { ...providers, id: prefix => `${prefix}-bundle` })
  ingest(db, 'owner-b', bundle(), { ...providers, id: prefix => `${prefix}-bundle` })
  await process(db, 'owner-a')
  await process(db, 'owner-b')
  expect(db.prepare('SELECT count(*) count FROM work_items').get()).toEqual({ count: 2 })
  expect(db.prepare('SELECT count(*) count FROM actions').get()).toEqual({ count: 2 })
  expect(db.prepare('SELECT count(*) count FROM outbox').get()).toEqual({ count: 2 })
  expect(loadSnapshot(db, 'owner-a', 'wi-1').workItem?.workItemId).toBe('wi-1')
  expect(loadSnapshot(db, 'owner-b', 'wi-1').workItem?.workItemId).toBe('wi-1')
  db.close()
})

it('returns the same receipt only for exact duplicates and durably rejects identifier conflicts', async () => {
  const { db } = database()
  ingest(db, 'owner-a', registration(), providers)
  const [committed] = await process(db)
  expect(ingest(db, 'owner-a', registration(), providers)).toEqual(committed)

  const sameEventDifferentKey = { ...registration('different-key'), eventId: 'event-register' }
  const conflict = ingest(db, 'owner-a', sameEventDifferentKey, providers)
  expect(conflict).toMatchObject({ status: 'rejected', rejectionCode: 'identifier_conflict' })
  expect(ingest(db, 'owner-a', sameEventDifferentKey, providers)).toEqual(conflict)

  ingest(db, 'owner-a', registration('second-key', 'accepted', 'wi-2'), { ...providers, id: prefix => `${prefix}-second` })
  const crossAlias = { ...registration('second-key', 'accepted', 'wi-3'), eventId: 'event-register' }
  expect(ingest(db, 'owner-a', crossAlias, providers)).toMatchObject({ rejectionCode: 'identifier_conflict' })
  expect(db.prepare('SELECT count(*) count FROM inbox WHERE owner_uid=?').get('owner-a')).toEqual({ count: 2 })
  expect(db.prepare('SELECT count(*) count FROM ingress_conflicts WHERE owner_uid=?').get('owner-a')).toEqual({ count: 2 })
  db.close()
})

it('is deterministic for identical kernel inputs', () => {
  const snapshot = { ownerUid: 'owner-a', workItem: null, attempt: null, candidate: null }
  expect(decide(snapshot, registration() as never)).toEqual(decide(snapshot, registration() as never))
})

describe('Candidate Commit', () => {
  it('commits one Candidate and one unique review action on duplicate submission', async () => {
    const { db } = database()
    await reachInProgress(db)
    ingest(db, 'owner-a', candidate(), { ...providers, id: prefix => `${prefix}-candidate` })
    const receipts = await process(db)
    const duplicate = ingest(db, 'owner-a', candidate(), providers)
    expect(duplicate).toEqual(receipts.at(-1))
    expect(db.prepare("SELECT count(*) count FROM candidates WHERE owner_uid='owner-a'").get()).toEqual({ count: 1 })
    expect(db.prepare("SELECT count(*) count FROM actions WHERE owner_uid='owner-a' AND kind='review_candidate'").get()).toEqual({ count: 1 })
    const row = db.prepare("SELECT work_item_revision FROM candidates WHERE owner_uid='owner-a'").get() as { work_item_revision: number }
    expect(row.work_item_revision).toBe(3)
    db.close()
  })

  it('durably rejects Candidate ID reuse and continues ordered inbox processing', async () => {
    const { db } = database()
    await reachCandidate(db)
    ingest(db, 'owner-a', candidate({ workItemRevision: 4 }, 'candidate-conflicting-path'), {
      ...providers, id: prefix => `${prefix}-candidate-conflict`
    })
    ingest(db, 'owner-a', envelope('reconcile_tick', 'reconcile-after-candidate-conflict', { scope: 'wi-1' }), {
      ...providers, id: prefix => `${prefix}-reconcile-after-conflict`
    })
    const receipts = await process(db)
    expect(receipts).toHaveLength(2)
    expect(receipts[0]).toMatchObject({ status: 'rejected', rejectionCode: 'candidate_id_conflict' })
    expect(receipts[1]).toMatchObject({ status: 'committed' })
    expect(db.prepare("SELECT status,rejection_code FROM inbox WHERE idempotency_key='candidate-conflicting-path'").get())
      .toEqual({ status: 'rejected', rejection_code: 'candidate_id_conflict' })
    expect(db.prepare("SELECT count(*) count FROM inbox WHERE status='pending'").get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT count(*) count FROM candidates WHERE candidate_id='candidate-1'").get()).toEqual({ count: 1 })
    db.close()
  })

  it.each([
    ['stale revision', { workItemRevision: 2 }, 'stale_work_item_revision'],
    ['stale generation', { generation: 0 }, 'stale_generation']
  ])('rejects %s without Candidate or review action', async (_name, override, code) => {
    const { db } = database()
    await reachInProgress(db)
    ingest(db, 'owner-a', candidate(override), { ...providers, id: prefix => `${prefix}-bad` })
    const [receipt] = await process(db)
    expect(receipt?.rejectionCode).toBe(code)
    expect(db.prepare('SELECT count(*) count FROM candidates').get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT count(*) count FROM actions WHERE kind='review_candidate'").get()).toEqual({ count: 0 })
    db.close()
  })
})

it.each([
  ['unauthenticated reviewer', fakeAdapters({ reviewerValid: false }), 'reviewer_authentication_invalid'],
  ['GitHub head drift', fakeAdapters({ headSha: 'head-moved' }), 'reviewed_deliverable_drifted']
])('rejects %s without accepting the Candidate', async (_name, selectedAdapters, code) => {
  const { db } = database()
  await reachCandidate(db)
  ingest(db, 'owner-a', reviewDecision('accepted', `review-${String(_name)}`), {
    ...providers, id: prefix => `${prefix}-${String(_name)}`
  })
  const [receipt] = await process(db, 'owner-a', selectedAdapters)
  expect(receipt?.rejectionCode).toBe(code)
  expect(loadSnapshot(db, 'owner-a', 'wi-1').workItem?.state).toBe('candidate')
  expect(db.prepare("SELECT count(*) count FROM actions WHERE kind='plan_next'").get()).toEqual({ count: 0 })
  db.close()
})

it('rejects owner-local Attempt ID reuse across Work Items', async () => {
  const { db } = database()
  ingest(db, 'owner-a', registration('register-1', 'accepted', 'wi-1'), providers)
  ingest(db, 'owner-a', registration('register-2', 'accepted', 'wi-2'), { ...providers, id: prefix => `${prefix}-register2` })
  await process(db)
  ingest(db, 'owner-a', bundle(1, 1, 'attempt-shared', 'bundle-1'), { ...providers, id: prefix => `${prefix}-bundle1` })
  await process(db)
  const secondBundle = bundle(1, 1, 'attempt-shared', 'bundle-2')
  secondBundle.payload.workItemId = 'wi-2'
  ingest(db, 'owner-a', secondBundle, { ...providers, id: prefix => `${prefix}-bundle2` })
  const [receipt] = await process(db)
  expect(receipt?.rejectionCode).toBe('attempt_id_conflict')
  expect(db.prepare("SELECT work_item_id FROM attempts WHERE attempt_id='attempt-shared'").get()).toEqual({ work_item_id: 'wi-1' })
  expect(loadSnapshot(db, 'owner-a', 'wi-2').workItem?.state).toBe('ready')
  db.close()
})

it('transactionally obsoletes predecessor Actions and prevents stale outbox wake', async () => {
  const { db } = database()
  ingest(db, 'owner-a', registration(), providers)
  ingest(db, 'owner-a', bundle(), { ...providers, id: prefix => `${prefix}-bundle` })
  await process(db)
  expect(db.prepare('SELECT state FROM outbox').get()).toEqual({ state: 'pending' })
  ingest(db, 'owner-a', started(), { ...providers, id: prefix => `${prefix}-started` }, {
    topicId: 'worker-topic', seqId: '1', senderUid: '1', serverReceivedAt: later
  })
  await process(db)
  expect(db.prepare('SELECT state FROM outbox').get()).toEqual({ state: 'obsolete' })
  expect(db.prepare("SELECT state FROM actions WHERE kind='execute_attempt'").get()).toEqual({ state: 'cancelled' })
  db.prepare("UPDATE actions SET state='ready' WHERE kind='execute_attempt'").run()
  db.prepare("UPDATE outbox SET state='pending',next_attempt_at=?").run(now)
  const fake = new FakeCatsco()
  expect(await runOutbox(db, 'owner-a', { catsco: fake })).toMatchObject({ satisfied: 0, retried: 0, obsolete: 1 })
  expect(db.prepare('SELECT state FROM outbox').get()).toEqual({ state: 'obsolete' })
  expect(fake.sends).toBe(0)
  db.close()
})

it('treats reported completed as non-authoritative', async () => {
  const { db } = database()
  await reachInProgress(db)
  ingest(db, 'owner-a', envelope('runtime_progress_observed', 'progress-completed', {
    workItemId: 'wi-1', attemptId: 'attempt-1', reportedState: 'completed'
  }), { ...providers, id: prefix => `${prefix}-progress` })
  await process(db)
  const snapshot = loadSnapshot(db, 'owner-a', 'wi-1')
  expect(snapshot.workItem?.state).toBe('in_progress')
  expect(snapshot.attempt?.reportedState).toBe('completion_reported')
  expect(snapshot.candidate).toBeNull()
  db.close()
})

it('supports changes requested then a fenced new work bundle', async () => {
  const { db } = database()
  await reachCandidate(db)
  ingest(db, 'owner-a', reviewDecision('changes_requested', 'review-rework'), { ...providers, id: prefix => `${prefix}-review` })
  await process(db)
  expect(loadSnapshot(db, 'owner-a', 'wi-1').workItem?.state).toBe('changes_requested')
  ingest(db, 'owner-a', bundle(5, 2), { ...providers, id: prefix => `${prefix}-bundle2` })
  await process(db)
  const snapshot = loadSnapshot(db, 'owner-a', 'wi-1')
  expect(snapshot.workItem?.state).toBe('assigned')
  expect(snapshot.attempt?.generation).toBe(2)
  db.close()
})

it('creates plan_next once only after terminal acceptance', async () => {
  const { db } = database()
  await reachCandidate(db)
  const review = reviewDecision('accepted', 'review-accepted')
  ingest(db, 'owner-a', review, { ...providers, id: prefix => `${prefix}-review` })
  const receipts = await process(db)
  expect(loadSnapshot(db, 'owner-a', 'wi-1').workItem?.state).toBe('accepted')
  expect(db.prepare("SELECT count(*) count FROM actions WHERE kind='plan_next'").get()).toEqual({ count: 1 })
  expect(ingest(db, 'owner-a', review, providers)).toEqual(receipts.at(-1))
  expect(db.prepare("SELECT count(*) count FROM actions WHERE kind='plan_next'").get()).toEqual({ count: 1 })
  db.close()
})

it('waits for exact-head merged close before plan_next for closed-terminal profiles', async () => {
  const { db } = database()
  await reachCandidate(db, 'closed')
  ingest(db, 'owner-a', reviewDecision('accepted', 'review-accepted-closed'), {
    ...providers, id: prefix => `${prefix}-closed-review`
  })
  await process(db)
  expect(loadSnapshot(db, 'owner-a', 'wi-1').workItem?.state).toBe('accepted')
  expect(db.prepare("SELECT count(*) count FROM actions WHERE kind='plan_next'").get()).toEqual({ count: 0 })

  const closePayload = {
    workItemId: 'wi-1', expectedRevision: 5, candidateId: 'candidate-1',
    repository: 'acme/repo', prNumber: 7, mergedHeadSha: 'head-123',
    deliverableDigest, acceptanceContractHash: hashes.acceptanceContractHash,
    observationRef: 'github:merge:7'
  }
  ingest(db, 'owner-a', envelope('deliverable_closed_observed', 'close-bad-head', {
    ...closePayload, mergedHeadSha: 'wrong-head'
  }), { ...providers, id: prefix => `${prefix}-bad-close` })
  const [rejected] = await process(db, 'owner-a', fakeAdapters({ state: 'closed', merged: true }))
  expect(rejected?.rejectionCode).toBe('close_deliverable_mismatch')
  expect(db.prepare("SELECT count(*) count FROM actions WHERE kind='plan_next'").get()).toEqual({ count: 0 })

  ingest(db, 'owner-a', envelope('deliverable_closed_observed', 'close-good', closePayload), {
    ...providers, id: prefix => `${prefix}-good-close`
  })
  await process(db, 'owner-a', fakeAdapters({ state: 'closed', merged: true }))
  expect(loadSnapshot(db, 'owner-a', 'wi-1').workItem?.state).toBe('closed')
  expect(db.prepare("SELECT count(*) count FROM actions WHERE kind='plan_next'").get()).toEqual({ count: 1 })
  db.close()
})

it('runs the complete Agent packet lifecycle through retry and exactly one plan_next', async () => {
  const { db } = database()
  const catsco = new LocalPilotCatscoAdapter('owner-a', [later, later, later])
  let ingressId = 0
  const send = async (event: any, topic: string, sender: string, at = later) => {
    catsco.enqueueObservation(topic, sender, event, at)
    await reconcile(db, 'owner-a', catsco, { ...providers, id: prefix => `${prefix}-lifecycle-${++ingressId}` })
    await process(db)
  }
  ingest(db, 'owner-a', registration(), providers)
  ingest(db, 'owner-a', bundle(), { ...providers, id: prefix => `${prefix}-bundle` })
  await process(db)
  const execute = JSON.parse(String((db.prepare('SELECT payload_json FROM outbox WHERE action_id=?').get('action:execute:attempt-1:1') as any).payload_json))
  const executePacket = JSON.parse(execute.renderedContent)
  expect(executePacket).toMatchObject({ kind:'execute_attempt', workItemId:'wi-1', generation:1, runtimePrincipal:'catsco-user:1', workBundle:{ contractDigest:'bundle-digest-1' }, contracts: hashes })

  await send(started(), 'worker-topic', '1')
  const candidateOne = candidate({}, 'candidate-lifecycle-1')
  await send(candidateOne, 'worker-topic', '1')
  const reviewOutbox = db.prepare("SELECT payload_json FROM outbox WHERE action_id=?").get('action:review:attempt-1:1') as any
  const reviewPacket = JSON.parse(JSON.parse(String(reviewOutbox.payload_json)).renderedContent)
  expect(reviewPacket).toMatchObject({ kind:'review_candidate', contracts: hashes, candidate:{ candidateId:'candidate-1', deliverable:{ headSha:'head-123' }, trustedEvidence:{ headSha:'head-123' } }, acceptanceContractHash: hashes.acceptanceContractHash })
  expect(ingest(db, 'owner-a', candidateOne, providers, { topicId:'worker-topic', seqId:'2', senderUid:'1', serverReceivedAt:later })).toMatchObject({ status:'committed' })

  await send(reviewDecision('changes_requested', 'review-lifecycle-change'), 'steward-topic', 'steward')
  ingest(db, 'owner-a', bundle(5, 2, 'attempt-2'), { ...providers, id: prefix => `${prefix}-bundle2` })
  await process(db)
  const executeTwo = JSON.parse(String((db.prepare('SELECT payload_json FROM outbox WHERE action_id=?').get('action:execute:attempt-2:2') as any).payload_json))
  expect(JSON.parse(executeTwo.renderedContent)).toMatchObject({ kind:'execute_attempt', generation:2, workBundle:{ contractDigest:'bundle-digest-2' } })
  await send(started(6, 2, 'attempt-2', 'started-2'), 'worker-topic', '2')
  const candidateTwo = candidate({ workItemRevision:7, attemptId:'attempt-2', generation:2, runtimePrincipal:'catsco-user:2', candidateId:'candidate-2' }, 'candidate-lifecycle-2')
  await send(candidateTwo, 'worker-topic', '2')
  const reviewTwo = reviewDecision('accepted', 'review-lifecycle-accepted', { expectedRevision:8, candidateId:'candidate-2' })
  await send(reviewTwo, 'steward-topic', 'steward')
  const planRows = db.prepare("SELECT action_id,kind,state FROM actions WHERE kind='plan_next'").all() as any[]
  expect(planRows).toHaveLength(1)
  expect(planRows[0]).toMatchObject({ action_id:'action:plan_next:wi-1:9', state:'ready' })
  expect(db.prepare("SELECT count(*) count FROM outbox WHERE action_id='action:plan_next:wi-1:9'").get()).toEqual({ count:1 })
  const planOutbox = db.prepare("SELECT payload_json FROM outbox WHERE action_id='action:plan_next:wi-1:9'").get() as any
  expect(JSON.parse(JSON.parse(String(planOutbox.payload_json)).renderedContent)).toMatchObject({ kind:'plan_next', completedWorkItem:{ workItemId:'wi-1', state:'accepted' }, loopId:'loop-1' })
  expect(ingest(db, 'owner-a', candidateTwo, providers, { topicId:'worker-topic', seqId:'4', senderUid:'2', serverReceivedAt:later })).toMatchObject({ status:'committed' })
  const duplicateReview = ingest(db, 'owner-a', reviewTwo, providers, { topicId:'steward-topic', seqId:'2', senderUid:'steward', serverReceivedAt:later })
  expect(duplicateReview).toMatchObject({ status:'committed' })
  db.close()
})

class FakeCatsco implements CatscoAdapter {
  sends = 0
  messages = new Map<string, CatscoMessageReceipt>()
  constructor(private failFirst = false, private uid = 'owner-a') {}
  async me() { return { uid: this.uid } }
  async findMessage(_topic: string, clientMsgId: string) { return this.messages.get(clientMsgId) ?? null }
  async sendExistingTopic(request: { content: string; clientMsgId: string }) {
    this.sends++
    if (this.failFirst && this.sends === 1) throw new Error('temporary failure')
    const receipt = { messageId: `message-${this.sends}`, clientMsgId: request.clientMsgId, duplicate: false, contentDigest: sha256(request.content) }
    this.messages.set(request.clientMsgId, receipt)
    return receipt
  }
}

it('retries outbox effects with backoff and stores an effect receipt', async () => {
  const { db } = database()
  ingest(db, 'owner-a', registration(), providers)
  ingest(db, 'owner-a', bundle(), { ...providers, id: prefix => `${prefix}-bundle` })
  await process(db)
  const fake = new FakeCatsco(true)
  const first = await runOutbox(db, 'owner-a', { catsco: fake }, 1, { now: () => now, token: () => 'claim-1' })
  expect(first).toMatchObject({ satisfied: 0, retried: 1 })
  const pending = db.prepare('SELECT state,attempt_count,last_error FROM outbox').get() as Record<string, unknown>
  expect(pending).toMatchObject({ state: 'pending', attempt_count: 1, last_error: 'temporary failure' })
  const second = await runOutbox(db, 'owner-a', { catsco: fake }, 1, { now: () => later, token: () => 'claim-2' })
  expect(second).toMatchObject({ satisfied: 1, retried: 0 })
  expect(db.prepare('SELECT count(*) count FROM effect_receipts').get()).toEqual({ count: 1 })
  expect(db.prepare('SELECT state FROM outbox').get()).toEqual({ state: 'satisfied' })
  db.close()
})

it('persists state and duplicate receipts across process restarts', async () => {
  const { db, path } = database()
  ingest(db, 'owner-a', registration(), providers)
  const [receipt] = await process(db)
  db.close()
  const reopened = openDatabase(path)
  migrate(reopened)
  expect(loadSnapshot(reopened, 'owner-a', 'wi-1').workItem?.state).toBe('ready')
  expect(ingest(reopened, 'owner-a', registration(), providers)).toEqual(receipt)
  reopened.close()
})
