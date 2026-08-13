import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, type SqliteDatabase } from '../src/store/sqlite.js'
import { initializeOwner, migrate } from '../src/store/migrate.js'
import { ingest, type Providers } from '../src/controller/ingest.js'
import { processPending, type ProcessingAdapters } from '../src/controller/process-inbox.js'
import { reconcile } from '../src/controller/reconcile.js'
import { runOutbox } from '../src/controller/outbox.js'
import { loadSnapshot } from '../src/store/repositories.js'
import type { CatscoAdapter, CatscoMessageReceipt, CatscoPollResult, CatscoSendRequest } from '../src/adapters/catsco.js'
import { sha256 } from '../src/lib/digest.js'

const dirs: string[] = []
const sentAt = '2026-08-04T00:00:00.000Z'
const later = '2026-08-04T00:02:00.000Z'
const hashes = {
  taskContractHash: 'task-hash-0001', referenceSnapshotHash: 'ref-hash-00001',
  writeScopeHash: 'scope-hash-001', acceptanceContractHash: 'accept-hash-01'
}
const providers: Providers = { now: () => sentAt, id: prefix => `${prefix}-fixed` }

function database(): SqliteDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'loopctl-evidence-lane-'))
  dirs.push(dir)
  const db = openDatabase(join(dir, 'loop.db'))
  migrate(db)
  initializeOwner(db, 'owner-a', sentAt)
  return db
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const processingAdapters: ProcessingAdapters = {
  runtime: { verify: async () => undefined },
  github: { readPullRequest: async (repository, prNumber) => ({
    repository, prNumber, headSha: 'head', baseSha: 'base', changedPaths: [], state: 'open', merged: false
  }) },
  reviewer: { verify: async () => ({ authenticatedPrincipal: 'catsco-user:574', receiptDigest: 'review-receipt' }) }
}

function event(type: string, key: string, payload: unknown) {
  return { type, eventId: `event-${key}`, idempotencyKey: key, source: 'catsco-user:559', entityRef: 'work_item:wi-1', payload }
}

function registration(coordinatorSessionTopicId?: string) {
  return event('work_item_registered', 'register', {
    workItemId: 'wi-1', loopId: 'loop-1', profileId: 'product@1', terminalState: 'accepted', ...hashes,
    writeScope: ['src/**'], githubRepo: 'acme/repo', catscoProjectId: '41',
    workerTopicId: 'grp_101', evidenceTopicId: 'grp_102', stewardTopicId: 'grp_103', stewardPrincipal: 'catsco-user:574',
    ...(coordinatorSessionTopicId ? { coordinatorSessionId: `session:v2:catscompany:p2p:${coordinatorSessionTopicId}:agent:574`, coordinatorSessionTopicId } : {})
  })
}

function bundle(attemptRoute?: Record<string, string>) {
  return event('work_bundle_proposed', 'bundle', {
    workItemId: 'wi-1', expectedRevision: 1, attemptId: 'attempt-1', attemptNumber: 1, generation: 1,
    runtimePrincipal: 'catsco-user:559', proofMode: 'catsco-message', leaseExpiresAt: '2026-08-05T00:00:00.000Z',
    workBundle: { contractDigest: 'bundle-digest', instructions: 'bounded work', deliverables: ['pull request'] },
    ...(attemptRoute ? { attemptRoute } : {}), ...hashes
  })
}

function permutedRecoveryBundle() {
  const event = recoveryBundle()
  return { ...event, eventId: 'event-recovery-permuted', idempotencyKey: 'recovery-permuted', payload: { ...event.payload, attemptRoute: {
    catscoProjectId: '41', workerTopicId: 'grp_102', evidenceTopicId: 'grp_103', stewardTopicId: 'grp_101', stewardPrincipal: 'catsco-user:574'
  } } }
}

function recoveryBundle(withRoute = true) {
  return event('work_bundle_proposed', withRoute ? 'recovery-bundle' : 'recovery-bundle-no-route', {
    workItemId: 'wi-1', expectedRevision: 4, attemptId: 'attempt-2', attemptNumber: 2, generation: 2,
    runtimePrincipal: 'catsco-user:559', proofMode: 'catsco-message', leaseExpiresAt: '2026-08-06T00:00:00.000Z',
    workBundle: { contractDigest: 'bundle-digest-2', instructions: 'bounded retry', deliverables: ['pull request'] },
    ...(withRoute ? { attemptRoute: { catscoProjectId: '41', workerTopicId: 'grp_201', evidenceTopicId: 'grp_202', stewardTopicId: 'grp_203', stewardPrincipal: 'catsco-user:574' } } : {}),
    ...hashes
  })
}

function ready() {
  return {
    type: 'worker_ready', eventId: 'event-ready', idempotencyKey: 'ready', source: 'catsco-user:559', entityRef: 'attempt:attempt-1',
    payload: {
      workItemId: 'wi-1', expectedRevision: 2, attemptId: 'attempt-1', generation: 1,
      runtimePrincipal: 'catsco-user:559', signature: 'catsco-message-attested'
    }
  }
}

function started() {
  return {
    type: 'runtime_started', eventId: 'event-started', idempotencyKey: 'started', source: 'catsco-user:559', entityRef: 'attempt:attempt-1',
    payload: {
      workItemId: 'wi-1', expectedRevision: 3, attemptId: 'attempt-1', generation: 1,
      runtimePrincipal: 'catsco-user:559', signature: 'catsco-message-attested'
    }
  }
}

class FakeCatsco implements CatscoAdapter {
  readonly polls: string[] = []
  readonly receipts = new Map<string, CatscoMessageReceipt>()
  async me() { return { uid: 'owner-a' } }
  async findMessage(topicId: string, clientMsgId: string) { return this.receipts.get(`${topicId}\u0000${clientMsgId}`) ?? null }
  async sendExistingTopic(request: CatscoSendRequest) {
    const receipt: CatscoMessageReceipt = {
      messageId: `message-${this.receipts.size + 1}`, clientMsgId: request.clientMsgId, duplicate: false,
      seqId: String(this.receipts.size + 1), contentDigest: sha256(request.content), serverConfirmed: true, serverReceivedAt: sentAt
    }
    this.receipts.set(`${request.topicId}\u0000${request.clientMsgId}`, receipt)
    return receipt
  }
  async poll(topicId: string, cursor: unknown): Promise<CatscoPollResult> {
    this.polls.push(topicId)
    return { observations: [], nextCursor: cursor ?? '0' }
  }
}

describe('quiet evidence lanes', () => {
  it('rejects an evidence route that aliases execution or review', () => {
    const db = database()
    const invalid = registration()
    invalid.payload.evidenceTopicId = 'grp_101'
    expect(() => ingest(db, 'owner-a', invalid, providers)).toThrow(/topics must be distinct/)
    db.close()
  })

  it('accepts a Coordinator P2P session distinct from the review group and rejects execution/evidence aliases', async () => {
    const route = {
      catscoProjectId: '41', workerTopicId: 'grp_101', evidenceTopicId: 'grp_102', stewardTopicId: 'grp_103', stewardPrincipal: 'catsco-user:574',
      workerSessionId: 'session:v2:catscompany:group:grp_101:agent:559', coordinatorSessionId: 'session:v2:catscompany:p2p:p2p_574_602:agent:574', coordinatorSessionTopicId: 'p2p_574_602'
    }
    const db = database()
    ingest(db, 'owner-a', registration('p2p_574_602'), providers)
    ingest(db, 'owner-a', bundle(route), { ...providers, id: (prefix: string) => `route-${prefix}` })
    expect((await processPending(db, 'owner-a', processingAdapters)).at(-1)).toMatchObject({ status: 'committed' })

    const invalid = { ...route, coordinatorSessionTopicId: 'grp_102' }
    const rejected = database()
    ingest(rejected, 'owner-a', registration('grp_102'), { ...providers, id: (prefix: string) => `rejected-register-${prefix}` })
    ingest(rejected, 'owner-a', { ...bundle(invalid), eventId: 'event-invalid-route', idempotencyKey: 'invalid-route' }, { ...providers, id: (prefix: string) => `rejected-route-${prefix}` })
    expect((await processPending(rejected, 'owner-a', processingAdapters)).at(-1)).toMatchObject({ status: 'rejected', rejectionCode: 'invalid_session_bound_route' })
    db.close()
    rejected.close()
  })

  it('uses a receipt-attested readiness gate before dispatching the execution Action', async () => {
    const db = database()
    ingest(db, 'owner-a', registration(), providers)
    ingest(db, 'owner-a', bundle(), { ...providers, id: prefix => `${prefix}-bundle` })
    await processPending(db, 'owner-a', processingAdapters)

    expect(loadSnapshot(db, 'owner-a', 'wi-1').attempt).toMatchObject({ controlState: 'preflight', reportedState: 'unknown' })
    expect(db.prepare('SELECT kind,state,target_topic_id FROM actions').all()).toEqual([
      { kind: 'preflight_attempt', state: 'ready', target_topic_id: 'grp_101' }
    ])

    ingest(db, 'owner-a', ready(), { ...providers, id: prefix => `${prefix}-early-ready` }, {
      topicId: 'grp_102', seqId: '1', senderUid: '559', serverReceivedAt: sentAt
    })
    expect((await processPending(db, 'owner-a', processingAdapters)).at(-1)).toMatchObject({ status: 'rejected', rejectionCode: 'worker_ready_before_preflight_receipt' })

    const catsco = new FakeCatsco()
    const preflightSentAt = '2026-08-04T00:00:01.000Z'
    await runOutbox(db, 'owner-a', { catsco }, 10, { now: () => preflightSentAt, token: () => 'claim-preflight' })
    const staleReady = { ...ready(), eventId: 'event-ready-before-send', idempotencyKey: 'ready-before-send' }
    ingest(db, 'owner-a', staleReady, { ...providers, id: prefix => `${prefix}-ready-before-send` }, {
      topicId: 'grp_102', seqId: '2', senderUid: '559', serverReceivedAt: sentAt
    })
    expect((await processPending(db, 'owner-a', processingAdapters)).at(-1)).toMatchObject({ status: 'rejected', rejectionCode: 'worker_ready_before_preflight_receipt' })
    const confirmedReady = { ...ready(), eventId: 'event-ready-confirmed', idempotencyKey: 'ready-confirmed' }
    ingest(db, 'owner-a', confirmedReady, { ...providers, id: prefix => `${prefix}-ready-confirmed` }, {
      topicId: 'grp_102', seqId: '3', senderUid: '559', serverReceivedAt: '2026-08-04T00:00:02.000Z'
    })
    await processPending(db, 'owner-a', processingAdapters)

    expect(loadSnapshot(db, 'owner-a', 'wi-1')).toMatchObject({
      workItem: { state: 'assigned', revision: 3, evidenceTopicId: 'grp_102' },
      attempt: { controlState: 'allocated', connectionState: 'connected' }
    })
    expect(db.prepare('SELECT kind,state,target_topic_id FROM actions ORDER BY kind').all()).toEqual([
      { kind: 'execute_attempt', state: 'ready', target_topic_id: 'grp_101' },
      { kind: 'preflight_attempt', state: 'satisfied', target_topic_id: 'grp_101' }
    ])
    db.close()
  })

  it('fences a receipt-delivered preflight that never reaches worker_ready', async () => {
    const db = database()
    ingest(db, 'owner-a', registration(), providers)
    ingest(db, 'owner-a', bundle(), { ...providers, id: prefix => `${prefix}-bundle` })
    await processPending(db, 'owner-a', processingAdapters)
    const catsco = new FakeCatsco()
    await runOutbox(db, 'owner-a', { catsco }, 10, { now: () => sentAt, token: () => 'claim-preflight' })
    const result = await reconcile(db, 'owner-a', catsco, { now: () => later, id: prefix => `${prefix}-readiness-timeout` }, undefined, {
      workerReadinessTimeoutMs: 60_000
    })
    expect(result).toMatchObject({ readinessTimedOut: 1 })
    expect(db.prepare("SELECT trusted_ingress_at FROM inbox WHERE event_id='attempt_readiness_timed_out:attempt-1:1'").get()).toEqual({ trusted_ingress_at: sentAt })
    await processPending(db, 'owner-a', processingAdapters)
    expect(loadSnapshot(db, 'owner-a', 'wi-1')).toMatchObject({
      workItem: { state: 'ready', revision: 3 },
      attempt: { controlState: 'superseded', reportedState: 'worker_readiness_timeout' }
    })
    db.close()
  })

  it.each([
    ['legacy', undefined, 'grp_103'],
    ['session-bound', 'p2p_574_602', 'p2p_574_602']
  ])('polls only evidence topics and fences a no-start execution before issuing exactly one %s recovery Action', async (_route, coordinatorSessionTopicId, expectedTargetTopicId) => {
    const db = database()
    ingest(db, 'owner-a', registration(coordinatorSessionTopicId), providers)
    ingest(db, 'owner-a', bundle(), { ...providers, id: prefix => `${prefix}-bundle` })
    await processPending(db, 'owner-a', processingAdapters)
    const catsco = new FakeCatsco()
    const preflightSentAt = '2026-08-04T00:00:01.000Z'
    await runOutbox(db, 'owner-a', { catsco }, 10, { now: () => preflightSentAt, token: () => 'claim-preflight' })
    ingest(db, 'owner-a', ready(), { ...providers, id: prefix => `${prefix}-ready` }, {
      topicId: 'grp_102', seqId: '1', senderUid: '559', serverReceivedAt: '2026-08-04T00:00:02.000Z'
    })
    await processPending(db, 'owner-a', processingAdapters)
    await runOutbox(db, 'owner-a', { catsco }, 10, { now: () => '2026-08-04T00:00:03.000Z', token: () => 'claim-execute' })
    const result = await reconcile(db, 'owner-a', catsco, { now: () => later, id: prefix => `${prefix}-timeout` }, undefined, {
      runtimeStartTimeoutMs: 60_000
    })
    expect(result).toMatchObject({ dispatchTimedOut: 1 })
    expect(catsco.polls).toEqual(['grp_102'])
    await processPending(db, 'owner-a', processingAdapters)

    expect(loadSnapshot(db, 'owner-a', 'wi-1')).toMatchObject({
      workItem: { state: 'ready', revision: 4 },
      attempt: { controlState: 'superseded', reportedState: 'runtime_start_timeout', connectionState: 'disconnected' }
    })
    expect(db.prepare("SELECT kind,state,target_topic_id FROM actions WHERE kind='recover_attempt'").all()).toEqual([
      { kind: 'recover_attempt', state: 'ready', target_topic_id: expectedTargetTopicId }
    ])

    ingest(db, 'owner-a', recoveryBundle(false), { ...providers, id: prefix => `${prefix}-recovery-missing-route` })
    expect((await processPending(db, 'owner-a', processingAdapters)).at(-1)).toMatchObject({ status: 'rejected', rejectionCode: 'recovery_route_required' })
    ingest(db, 'owner-a', permutedRecoveryBundle(), { ...providers, id: prefix => `${prefix}-recovery-permuted` })
    expect((await processPending(db, 'owner-a', processingAdapters)).at(-1)).toMatchObject({ status: 'rejected', rejectionCode: 'recovery_route_not_fresh' })
    ingest(db, 'owner-a', recoveryBundle(), { ...providers, id: prefix => `${prefix}-recovery-route` })
    await processPending(db, 'owner-a', processingAdapters)
    expect(loadSnapshot(db, 'owner-a', 'wi-1')).toMatchObject({
      workItem: { state: 'assigned', revision: 5, workerTopicId: 'grp_201', evidenceTopicId: 'grp_202', stewardTopicId: 'grp_203' },
      attempt: { attemptId: 'attempt-2', generation: 2, controlState: 'preflight' }
    })

    ingest(db, 'owner-a', started(), { ...providers, id: prefix => `${prefix}-late-started` }, {
      topicId: 'grp_102', seqId: '2', senderUid: '559', serverReceivedAt: later
    })
    const [late] = await processPending(db, 'owner-a', processingAdapters)
    expect(late).toMatchObject({ status: 'rejected' })
    db.close()
  })
})
