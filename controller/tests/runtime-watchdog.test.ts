import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, type SqliteDatabase } from '../src/store/sqlite.js'
import { initializeOwner, migrate } from '../src/store/migrate.js'
import { ingest, type Providers } from '../src/controller/ingest.js'
import { processPending, type ProcessingAdapters } from '../src/controller/process-inbox.js'
import { runOutbox } from '../src/controller/outbox.js'
import { reconcile } from '../src/controller/reconcile.js'
import type { CatscoAdapter, CatscoMessageReceipt } from '../src/adapters/catsco.js'
import { loadSnapshot } from '../src/store/repositories.js'
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
  const dir = mkdtempSync(join(tmpdir(), 'loopctl-watchdog-'))
  dirs.push(dir)
  const db = openDatabase(join(dir, 'loop.db'))
  migrate(db)
  initializeOwner(db, 'owner-a', sentAt)
  return db
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const event = (type: string, key: string, payload: unknown) => ({
  type, eventId: `event-${key}`, idempotencyKey: key, source: 'test', entityRef: 'work_item:wi-1', payload
})

const processingAdapters: ProcessingAdapters = {
  runtime: { verify: async () => undefined },
  github: { readPullRequest: async (repository, prNumber) => ({
    repository, prNumber, headSha: 'head', baseSha: 'base', changedPaths: [], state: 'open', merged: false
  }) },
  reviewer: { verify: async () => ({ authenticatedPrincipal: 'steward', receiptDigest: 'receipt' }) }
}

class FakeCatsco implements CatscoAdapter {
  private readonly messages = new Map<string, CatscoMessageReceipt>()
  async me() { return { uid: 'owner-a' } }
  async poll() { return { observations: [], nextCursor: null } }
  async findMessage(_topicId: string, clientMsgId: string) { return this.messages.get(clientMsgId) ?? null }
  async sendExistingTopic(request: { content: string; clientMsgId: string }) {
    const receipt = {
      messageId: `message-${this.messages.size + 1}`,
      clientMsgId: request.clientMsgId,
      duplicate: false,
      contentDigest: sha256(request.content)
    }
    this.messages.set(request.clientMsgId, receipt)
    return receipt
  }
}

it('marks an assigned attempt bridge-unavailable after a bounded post-send timeout', async () => {
  const db = database()
  ingest(db, 'owner-a', event('work_item_registered', 'register', {
    workItemId: 'wi-1', loopId: 'loop-1', profileId: 'product@1', terminalState: 'accepted', ...hashes,
    writeScope: ['src/**'], githubRepo: 'acme/repo', catscoProjectId: 'project-1',
    workerTopicId: 'worker-topic', stewardTopicId: 'steward-topic'
  }), providers)
  ingest(db, 'owner-a', event('work_bundle_proposed', 'bundle', {
    workItemId: 'wi-1', expectedRevision: 1, attemptId: 'attempt-1', attemptNumber: 1, generation: 1,
    runtimePrincipal: 'catsco-user:559', proofMode: 'catsco-message', leaseExpiresAt: '2026-08-05T00:00:00.000Z',
    workBundle: { contractDigest: 'bundle-digest', instructions: 'do bounded work', deliverables: ['pull request'] }, ...hashes
  }), { ...providers, id: prefix => `${prefix}-bundle` })
  await processPending(db, 'owner-a', processingAdapters)

  const catsco = new FakeCatsco()
  await runOutbox(db, 'owner-a', { catsco }, 10, {
    now: () => sentAt,
    token: () => 'claim-1'
  })

  const first = await reconcile(db, 'owner-a', catsco, { now: () => later, id: prefix => `${prefix}-watchdog` }, undefined, { runtimeStartTimeoutMs: 60_000 })
  expect(first).toMatchObject({ status: 'enqueued', observations: 0, bridgeUnavailable: 1 })
  await processPending(db, 'owner-a', processingAdapters)
  expect(loadSnapshot(db, 'owner-a', 'wi-1').attempt).toMatchObject({
    controlState: 'allocated', reportedState: 'runtime_bridge_unavailable', connectionState: 'unknown'
  })

  const second = await reconcile(db, 'owner-a', catsco, { now: () => later, id: prefix => `${prefix}-watchdog-again` }, undefined, { runtimeStartTimeoutMs: 60_000 })
  expect(second).toMatchObject({ bridgeUnavailable: 0 })
  db.close()
})
