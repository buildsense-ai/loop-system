import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OpenCliCatscoAdapter } from '../src/adapters/catsco-opencli.js'
import type { CatscoAdapter, CatscoMessageReceipt } from '../src/adapters/catsco.js'
import type { ProcessResult } from '../src/lib/process.js'
import { wakeAgentPostcondition, type WakeAgentEffect } from '../src/protocol/effects.js'
import { openDatabase, type SqliteDatabase } from '../src/store/sqlite.js'
import { initializeOwner, migrate } from '../src/store/migrate.js'
import { ingest } from '../src/controller/ingest.js'
import { processPending } from '../src/controller/process-inbox.js'
import { runOutbox } from '../src/controller/outbox.js'
import { reconcile } from '../src/controller/reconcile.js'
import { canonicalize } from '../src/lib/canonical-json.js'
import { sha256 } from '../src/lib/digest.js'

const dirs: string[] = []
const now = '2026-08-04T00:00:00.000Z'
const serverTime = '2026-08-04T00:03:00.000Z'
const hashes = {
  taskContractHash: 'task-hash-0001', referenceSnapshotHash: 'ref-hash-00001',
  writeScopeHash: 'scope-hash-001', acceptanceContractHash: 'accept-hash-01'
}
const providers = { now: () => now, id: (prefix: string) => `${prefix}-${Math.random()}` }
const processingAdapters = {
  runtime: { verify: async () => undefined },
  github: { readPullRequest: async () => { throw new Error('not used') } },
  reviewer: { verify: async () => { throw new Error('not used') } }
}

function db(): SqliteDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'loopctl-catsco-'))
  dirs.push(dir)
  const database = openDatabase(join(dir, 'loop.db'))
  migrate(database)
  initializeOwner(database, 'owner-a', now)
  return database
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function event(type: string, key: string, payload: unknown) {
  return { type, eventId: `event-${key}`, idempotencyKey: key, source: 'catsco', entityRef: 'work_item:wi-1', payload }
}
function registration(workerTopicId = 'worker-topic', stewardTopicId = 'steward-topic') {
  return event('work_item_registered', 'register', {
    workItemId: 'wi-1', loopId: 'loop-1', profileId: 'product@1', terminalState: 'accepted', ...hashes,
    writeScope: ['src/**'], githubRepo: 'acme/repo', catscoProjectId: 'project-1',
    workerTopicId, stewardTopicId, stewardPrincipal: 'catsco-user:574'
  })
}
function candidateEvent(key = 'candidate-polled') {
  return event('candidate_submitted', key, {
    ownerUid: 'owner-a', workItemId: 'wi-1', workItemRevision: 3, attemptId: 'attempt-1', generation: 1,
    runtimePrincipal: 'catsco-user:559', proofMode: 'catsco-message', candidateId: `candidate-${key}`,
    deliverable: { kind: 'github_pr', repository: 'acme/repo', prNumber: 7, headSha: 'head-123', baseSha: 'base-123', digest: 'deliverable-digest' },
    ...hashes
  })
}
function reviewEvent(key = 'review-polled') {
  return event('review_decided', key, {
    workItemId: 'wi-1', expectedRevision: 4, candidateId: 'candidate-1', outcome: 'accepted',
    reviewerPrincipal: 'catsco-user:574', reviewedHeadSha: 'head-123',
    reviewedDeliverableDigest: 'deliverable-digest', acceptanceContractHash: hashes.acceptanceContractHash
  })
}
function bundle(runtimePrincipal = 'runtime-1') {
  return event('work_bundle_proposed', 'bundle', {
    workItemId: 'wi-1', expectedRevision: 1, attemptId: 'attempt-1', attemptNumber: 1, generation: 1,
    runtimePrincipal, proofKeyId: 'key-1', proofPublicKey: 'unused',
    leaseExpiresAt: '2026-08-05T00:00:00.000Z',
    workBundle: { contractDigest: 'bundle-digest-1', instructions: 'work', deliverables: ['pull request'] }, ...hashes
  })
}
async function withOutbox(database: SqliteDatabase, options: { group?: boolean } = {}) {
  const topic = options.group ? 'grp_42' : 'worker-topic'
  ingest(database, 'owner-a', registration(topic, options.group ? topic : 'steward-topic'), providers)
  ingest(database, 'owner-a', bundle(options.group ? 'catsco-user:559' : 'runtime-1'), providers)
  await processPending(database, 'owner-a', processingAdapters)
  return database.prepare('SELECT * FROM outbox').get() as Record<string, unknown>
}

function queuedRunner(outputs: unknown[], calls: string[][]) {
  return async (_command: string, args: readonly string[]): Promise<ProcessResult> => {
    calls.push([...args])
    const output = outputs.shift()
    return { stdout: JSON.stringify(output), stderr: '', code: 0 }
  }
}

describe('OpenCLI CatsCo P0 adapter', () => {
  it('uses exact send/receipt argv and parses enveloped/direct duplicate receipts', async () => {
    const calls: string[][] = []
    const adapter = new OpenCliCatscoAdapter('opencli-test', queuedRunner([
      { data: [{ messageId: '41', clientMsgId: 'client-1', seqId: '41', duplicate: true, contentDigest: 'digest-1' }] },
      { found: true, messageId: 41, clientMsgId: 'client-1', seqId: 41, duplicate: false,
        contentDigest: 'digest-1', serverConfirmed: true, serverReceivedAt: serverTime }
    ], calls))

    await expect(adapter.sendExistingTopic({
      topicId: 'topic-1', content: '{"exact":true}', clientMsgId: 'client-1'
    })).resolves.toMatchObject({
      messageId: '41', duplicate: true, contentDigest: 'digest-1'
    })
    await expect(adapter.findMessage('topic-1', 'client-1')).resolves.toMatchObject({
      messageId: '41', serverConfirmed: true, serverReceivedAt: serverTime
    })
    expect(calls).toEqual([
      ['catsco', 'send', 'topic-1', '{"exact":true}', '--client-message-id', 'client-1', '--format', 'json'],
      ['catsco', 'message-receipt', 'topic-1', '--client-message-id', 'client-1', '--format', 'json']
    ])
  })

  it('passes a canonical structured mention when sending to a group', async () => {
    const calls: string[][] = []
    const adapter = new OpenCliCatscoAdapter('opencli-test', queuedRunner([{
      messageId: '42', clientMsgId: 'client-2', seqId: '42', duplicate: false, contentDigest: 'digest-2'
    }], calls))

    await adapter.sendExistingTopic({
      topicId: 'grp_42', content: '{"exact":true}', clientMsgId: 'client-2', mention: 'usr559'
    })
    expect(calls[0]).toEqual([
      'catsco', 'send', 'grp_42', '{"exact":true}', '--client-message-id', 'client-2',
      '--mention', 'usr559', '--format', 'json'
    ])
  })

  it('skips plain text before valid Candidate/review and returns the verified envelope cursor', async () => {
    const calls: string[][] = []
    const adapter = new OpenCliCatscoAdapter('opencli-test', queuedRunner([{ data: {
      items: [
        { seqId: '13', topicId: 'topic-1', senderUid: '574', content: JSON.stringify(reviewEvent()), serverReceivedAt: '2026-08-04T00:13:00.000Z' },
        { seqId: '11', topicId: 'topic-1', senderUid: '574', content: 'ordinary chat', serverReceivedAt: '2026-08-04T00:11:00.000Z' },
        { seqId: '12', topicId: 'topic-1', senderUid: '559', content: JSON.stringify(candidateEvent()), serverReceivedAt: '2026-08-04T00:12:00.000Z' }
      ], nextCursor: '13', hasMore: false
    } }], calls))

    const result = await adapter.poll('topic-1', '10')
    expect(result.nextCursor).toBe('13')
    expect(result.observations.map(item => [item.event.type, item.attestation.seqId])).toEqual([
      ['candidate_submitted', '12'], ['review_decided', '13']
    ])
    expect(calls[0]).toEqual([
      'catsco', 'messages', 'topic-1', '--after-seq', '10', '--limit', '200', '--format', 'json'
    ])
  })

  it('advances one bounded page at a time when the topic has more history', async () => {
    const calls: string[][] = []
    const adapter = new OpenCliCatscoAdapter('opencli-test', queuedRunner([{ data: {
      items: [{ seqId: '201', topicId: 'topic-1', senderUid: '559', content: 'ordinary chat', serverReceivedAt: serverTime }],
      nextCursor: '201', hasMore: true
    } }, { data: {
      items: [{ seqId: '202', topicId: 'topic-1', senderUid: '559', content: JSON.stringify(candidateEvent()), serverReceivedAt: serverTime }],
      nextCursor: '202', hasMore: false
    } }], calls))

    const first = await adapter.poll('topic-1', '200')
    const second = await adapter.poll('topic-1', first.nextCursor)
    expect(first).toMatchObject({ nextCursor: '201', observations: [] })
    expect(second.observations.map(item => [item.event.type, item.attestation.seqId])).toEqual([['candidate_submitted', '202']])
    expect(calls).toEqual([
      ['catsco', 'messages', 'topic-1', '--after-seq', '200', '--limit', '200', '--format', 'json'],
      ['catsco', 'messages', 'topic-1', '--after-seq', '201', '--limit', '200', '--format', 'json']
    ])
  })

  it('skips all noise and disallowed JSON control events while advancing the envelope cursor', async () => {
    const adapter = new OpenCliCatscoAdapter('opencli-test', queuedRunner([{ items: [
      { seqId: '21', topicId: 'topic-1', senderUid: '559', content: 'not json', serverReceivedAt: serverTime },
      { seqId: '22', topicId: 'topic-1', senderUid: '559', content: '{"type":"unknown"}', serverReceivedAt: serverTime },
      { seqId: '23', topicId: 'topic-1', senderUid: '559', content: JSON.stringify(registration()), serverReceivedAt: serverTime },
      { seqId: '24', topicId: 'topic-1', senderUid: '559', content: JSON.stringify(event('runtime_started', 'noise-started', {
        workItemId: 'wi-1', expectedRevision: 2, attemptId: 'attempt-1', generation: 1,
        runtimePrincipal: 'catsco-user:559', signature: 'not-authority'
      })), serverReceivedAt: serverTime }
    ], nextCursor: '24', hasMore: false }], []))

    await expect(adapter.poll('topic-1', '20')).resolves.toMatchObject({ nextCursor: '24', observations: [{ event: { type: 'runtime_started' }, attestation: { senderUid: '559', topicId: 'topic-1' } }] })
  })

  it('rejects a server envelope for a different topic', async () => {
    const adapter = new OpenCliCatscoAdapter('opencli-test', queuedRunner([{ items: [{
      seqId: '1', topicId: 'other-topic', senderUid: '574', content: JSON.stringify(event('reconcile_tick', 'wrong-topic', { scope: 'wi-1' })),
      serverReceivedAt: serverTime
    }], nextCursor: '1', hasMore: false }], []))
    await expect(adapter.poll('topic-1', '0')).rejects.toThrow('while polling topic-1')
  })
})

describe('content-addressed outbox sends', () => {
  class ReceiptAdapter implements CatscoAdapter {
    sends = 0
    sentIds: string[] = []
    sentMentions: Array<string | undefined> = []
    constructor(readonly found: CatscoMessageReceipt | null) {}
    async me() { return { uid: 'owner-a' } }
    async findMessage() { return this.found }
    async sendExistingTopic(request: { content: string; clientMsgId: string; mention?: string }) {
      this.sends++
      this.sentIds.push(request.clientMsgId)
      this.sentMentions.push(request.mention)
      return { messageId: 'sent-1', clientMsgId: request.clientMsgId, duplicate: false, contentDigest: sha256(request.content) }
    }
  }

  it('derives the client id from effect key and exact content digest', () => {
    const effect = {
      type: 'wake_agent', effectKey: 'effect-1', actionId: 'action-1', actionWorkItemRevision: 1,
      targetPrincipal: 'runtime-1', targetDigest: 'target-1', targetTopicId: 'topic-1', packetDigest: 'packet-1'
    } satisfies WakeAgentEffect
    const changed = { ...effect, packetDigest: 'packet-2' }
    expect(wakeAgentPostcondition('owner-a', effect).clientMsgId)
      .not.toBe(wakeAgentPostcondition('owner-a', changed).clientMsgId)
    expect(wakeAgentPostcondition('owner-a', effect).contentDigest)
      .not.toBe(wakeAgentPostcondition('owner-a', changed).contentDigest)
    expect(wakeAgentPostcondition('owner-a', effect).clientMsgId)
      .not.toBe(wakeAgentPostcondition('owner-b', effect).clientMsgId)
    expect(wakeAgentPostcondition('owner-a', effect).clientMsgId)
      .not.toBe(wakeAgentPostcondition('owner-a', { ...effect, targetTopicId: 'topic-2' }).clientMsgId)
    expect(wakeAgentPostcondition('owner-a', effect)).toMatchObject({
      transportVersion: 'catsco-opencli-p0-v1', ownerUid: 'owner-a', targetTopicId: 'topic-1', effectKey: 'effect-1'
    })
  })

  it('binds a group target mention into the transport identity', () => {
    const groupEffect = {
      type: 'wake_agent', effectKey: 'effect-group', actionId: 'action-group', actionWorkItemRevision: 1,
      targetPrincipal: 'catsco-user:559', targetDigest: 'target-group', targetTopicId: 'grp_42', packetDigest: 'packet-group'
    } satisfies WakeAgentEffect
    const expected = wakeAgentPostcondition('owner-a', groupEffect)
    expect(expected).toMatchObject({ transportVersion: 'catsco-opencli-group-v2', targetMention: 'usr559' })
    expect(expected.clientMsgId).not.toBe(wakeAgentPostcondition('owner-a', {
      ...groupEffect, targetPrincipal: 'catsco-user:574'
    }).clientMsgId)
  })

  it('sends a group Action with the target principal as structured mention', async () => {
    const database = db()
    const row = await withOutbox(database, { group: true })
    const expected = JSON.parse(String(row.postcondition_json)) as { clientMsgId: string; contentDigest: string }
    const adapter = new ReceiptAdapter(null)
    await expect(runOutbox(database, 'owner-a', { catsco: adapter }, 1, {
      now: () => now, token: () => 'claim'
    })).resolves.toMatchObject({ satisfied: 1, retried: 0 })
    expect(adapter.sentMentions).toEqual(['usr559'])
    expect(adapter.sentIds).toEqual([expected.clientMsgId])
    database.close()
  })

  it('fails closed for a group Action with a non-CatsCo target principal', async () => {
    const effect = {
      type: 'wake_agent', effectKey: 'effect-invalid', actionId: 'action-invalid', actionWorkItemRevision: 1,
      targetPrincipal: 'runtime-1', targetDigest: 'target-invalid', targetTopicId: 'grp_42', packetDigest: 'packet-invalid'
    } satisfies WakeAgentEffect
    expect(() => wakeAgentPostcondition('owner-a', effect)).toThrow('numeric CatsCo target principal')
  })

  it('safely resends when a local-registry receipt is not server confirmed', async () => {
    const database = db()
    const row = await withOutbox(database)
    const expected = JSON.parse(String(row.postcondition_json)) as { clientMsgId: string; contentDigest: string }
    const adapter = new ReceiptAdapter({
      messageId: 'local-1', clientMsgId: expected.clientMsgId, duplicate: false,
      contentDigest: expected.contentDigest, serverConfirmed: false
    })
    await expect(runOutbox(database, 'owner-a', { catsco: adapter }, 1, {
      now: () => now, token: () => 'claim'
    })).resolves.toMatchObject({ satisfied: 1, retried: 0 })
    expect(adapter.sends).toBe(1)
    expect(adapter.sentIds).toEqual([expected.clientMsgId])
    database.close()
  })

  it('fails closed on a local receipt digest mismatch', async () => {
    const database = db()
    const row = await withOutbox(database)
    const expected = JSON.parse(String(row.postcondition_json)) as { clientMsgId: string }
    const adapter = new ReceiptAdapter({
      messageId: 'local-1', clientMsgId: expected.clientMsgId, duplicate: false,
      contentDigest: 'wrong-digest', serverConfirmed: true
    })
    await expect(runOutbox(database, 'owner-a', { catsco: adapter }, 1, {
      now: () => now, token: () => 'claim'
    })).resolves.toMatchObject({ satisfied: 0, retried: 1 })
    expect(adapter.sends).toBe(0)
    expect(database.prepare('SELECT state,last_error FROM outbox').get()).toMatchObject({
      state: 'pending', last_error: expect.stringContaining('receipt conflict: content digest')
    })
    database.close()
  })

  it('obsoletes pre-v3 pending effects instead of retrying weaker transport identities', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loopctl-catsco-v2-'))
    dirs.push(dir)
    const database = openDatabase(join(dir, 'loop.db'))
    database.exec(readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'))
    database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)').run(now)
    database.exec(readFileSync(new URL('../migrations/002_fencing_and_conflicts.sql', import.meta.url), 'utf8'))
    database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(2,?)').run(now)
    // Give the current writer its additive columns while deliberately leaving transport v3 unapplied.
    database.exec(readFileSync(new URL('../migrations/004_catsco_attestation_authority.sql', import.meta.url), 'utf8'))
    database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(4,?)').run(now)
    initializeOwner(database, 'owner-a', now)
    await withOutbox(database)

    migrate(database)
    expect(database.prepare('SELECT state,last_error FROM outbox').get()).toMatchObject({
      state: 'obsolete', last_error: expect.stringContaining('pre-v3 transport postcondition')
    })
    expect(database.prepare('SELECT state FROM actions').get()).toEqual({ state: 'cancelled' })
    database.close()
  })

  it('blocks pending payload and destination-only mutation in SQLite', async () => {
    const database = db()
    const row = await withOutbox(database)
    const effect = JSON.parse(String(row.payload_json)) as WakeAgentEffect
    expect(() => database.prepare('UPDATE outbox SET payload_json=?').run(
      canonicalize({ ...effect, packetDigest: 'changed-packet' })
    )).toThrow('outbox effect identity')
    expect(() => database.prepare('UPDATE outbox SET payload_json=?').run(
      canonicalize({ ...effect, targetTopicId: 'different-topic' })
    )).toThrow('outbox effect identity')
    expect(database.prepare('SELECT payload_json FROM outbox').get()).toEqual({ payload_json: row.payload_json })
    database.close()
  })
})

describe('CatsCo reconciliation cursor safety', () => {
  it('uses serverReceivedAt as trusted ingress and advances only after ingest', async () => {
    const database = db()
    ingest(database, 'owner-a', registration(), providers)
    await processPending(database, 'owner-a', processingAdapters)
    const observed = candidateEvent('candidate-cursor')
    const adapter: CatscoAdapter = {
      me: async () => ({ uid: 'owner-a' }),
      findMessage: async () => null,
      sendExistingTopic: async () => { throw new Error('not used') },
      poll: async (topicId, cursor) => topicId === 'worker-topic'
        ? { observations: [{ event: observed, attestation: { topicId, seqId: '9', senderUid: '559', serverReceivedAt: serverTime } }], nextCursor: '9' }
        : { observations: [], nextCursor: cursor ?? '0' }
    }
    await expect(reconcile(database, 'owner-a', adapter, providers)).resolves.toMatchObject({ observations: 1 })
    expect(database.prepare("SELECT trusted_ingress_at FROM inbox WHERE idempotency_key='candidate-cursor'").get())
      .toEqual({ trusted_ingress_at: serverTime })
    expect(database.prepare("SELECT cursor_json FROM source_cursors WHERE scope_key='worker-topic'").get())
      .toEqual({ cursor_json: '"9"' })
    database.close()
  })

  it('advances a durable topic cursor for an all-noise batch with zero Loop observations', async () => {
    const database = db()
    ingest(database, 'owner-a', registration(), providers)
    await processPending(database, 'owner-a', processingAdapters)
    const adapter: CatscoAdapter = {
      me: async () => ({ uid: 'owner-a' }),
      findMessage: async () => null,
      sendExistingTopic: async () => { throw new Error('not used') },
      poll: async (topicId, cursor) => topicId === 'worker-topic'
        ? { observations: [], nextCursor: '15' }
        : { observations: [], nextCursor: cursor ?? '0' }
    }
    await expect(reconcile(database, 'owner-a', adapter, providers)).resolves.toMatchObject({ observations: 0 })
    expect(database.prepare("SELECT cursor_json FROM source_cursors WHERE scope_key='worker-topic'").get())
      .toEqual({ cursor_json: '"15"' })
    database.close()
  })

  it('skips an attested worker-topic work_item_registered without creating state', async () => {
    const database = db()
    ingest(database, 'owner-a', registration(), providers)
    await processPending(database, 'owner-a', processingAdapters)
    const malicious = registration()
    malicious.eventId = 'event-polled-register'
    malicious.idempotencyKey = 'polled-register'
    malicious.entityRef = 'work_item:wi-evil'
    malicious.payload.workItemId = 'wi-evil'
    const adapter: CatscoAdapter = {
      me: async () => ({ uid: 'owner-a' }),
      findMessage: async () => null,
      sendExistingTopic: async () => { throw new Error('not used') },
      poll: async (topicId, cursor) => topicId === 'worker-topic' ? { observations: [{
        event: malicious,
        attestation: { topicId, seqId: '16', senderUid: '559', serverReceivedAt: serverTime }
      }], nextCursor: '16' } : { observations: [], nextCursor: cursor ?? '0' }
    }
    await expect(reconcile(database, 'owner-a', adapter, providers)).resolves.toMatchObject({ observations: 0 })
    await processPending(database, 'owner-a', processingAdapters)
    expect(database.prepare("SELECT count(*) count FROM work_items WHERE work_item_id='wi-evil'").get())
      .toEqual({ count: 0 })
    expect(database.prepare("SELECT count(*) count FROM inbox WHERE event_id='event-polled-register'").get())
      .toEqual({ count: 0 })
    expect(database.prepare("SELECT cursor_json FROM source_cursors WHERE scope_key='worker-topic'").get())
      .toEqual({ cursor_json: '"16"' })
    database.close()
  })

  it('rejects an authenticated-owner mismatch before polling, ingest, or cursor advance', async () => {
    const database = db()
    ingest(database, 'owner-a', registration(), providers)
    await processPending(database, 'owner-a', processingAdapters)
    database.prepare(`INSERT INTO source_cursors(owner_uid,source,scope_key,cursor_json,updated_at)
      VALUES('owner-a','catsco','worker-topic','\"7\"',?)`).run(now)
    let polls = 0
    const adapter: CatscoAdapter = {
      me: async () => ({ uid: 'owner-b' }),
      findMessage: async () => null,
      sendExistingTopic: async () => { throw new Error('not used') },
      poll: async (_topicId, cursor) => { polls++; return { observations: [], nextCursor: cursor ?? '0' } }
    }
    await expect(reconcile(database, 'owner-a', adapter, providers)).rejects.toThrow('authenticated owner')
    expect(polls).toBe(0)
    expect(database.prepare("SELECT cursor_json FROM source_cursors WHERE scope_key='worker-topic'").get())
      .toEqual({ cursor_json: '"7"' })
    expect(database.prepare('SELECT count(*) count FROM inbox').get()).toEqual({ count: 1 })
    database.close()
  })

  it('polls unique active worker and steward topics once after one identity check', async () => {
    const database = db()
    ingest(database, 'owner-a', registration(), providers)
    const second = registration()
    second.eventId = 'event-register-2'
    second.idempotencyKey = 'register-2'
    second.payload.workItemId = 'wi-2'
    second.entityRef = 'work_item:wi-2'
    second.payload.workerTopicId = 'steward-topic'
    second.payload.stewardTopicId = 'shared-topic'
    ingest(database, 'owner-a', second, { ...providers, id: prefix => `${prefix}-2` })
    await processPending(database, 'owner-a', processingAdapters)
    let meCalls = 0
    const polls: string[] = []
    const adapter: CatscoAdapter = {
      me: async () => { meCalls++; return { uid: 'owner-a' } },
      findMessage: async () => null,
      sendExistingTopic: async () => { throw new Error('not used') },
      poll: async (topicId, cursor) => { polls.push(topicId); return { observations: [], nextCursor: cursor ?? '0' } }
    }
    await reconcile(database, 'owner-a', adapter, providers)
    expect(meCalls).toBe(1)
    expect(polls).toEqual(['worker-topic', 'steward-topic', 'shared-topic'])
    database.close()
  })

  it('does not advance a topic cursor when observation attestation authority fails', async () => {
    const database = db()
    ingest(database, 'owner-a', registration(), providers)
    await processPending(database, 'owner-a', processingAdapters)
    database.prepare(`INSERT INTO source_cursors(owner_uid,source,scope_key,cursor_json,updated_at)
      VALUES('owner-a','catsco','worker-topic','"7"',?)`).run(now)
    const adapter: CatscoAdapter = {
      me: async () => ({ uid: 'owner-a' }),
      findMessage: async () => null,
      sendExistingTopic: async () => { throw new Error('not used') },
      poll: async (topicId, cursor) => topicId === 'worker-topic' ? { observations: [{
        event: candidateEvent('attestation-mismatch'),
        attestation: { topicId: 'forged-topic', seqId: '8', senderUid: '574', serverReceivedAt: serverTime }
      }], nextCursor: '8' } : { observations: [], nextCursor: cursor ?? '0' }
    }
    await expect(reconcile(database, 'owner-a', adapter, providers)).rejects.toThrow('does not match the polled topic')
    expect(database.prepare("SELECT cursor_json FROM source_cursors WHERE scope_key='worker-topic'").get())
      .toEqual({ cursor_json: '"7"' })
    expect(database.prepare("SELECT count(*) count FROM inbox WHERE event_id='event-attestation-mismatch'").get())
      .toEqual({ count: 0 })
    database.close()
  })

  it('does not advance cursors when durable ingest fails', async () => {
    const database = db()
    ingest(database, 'owner-a', registration(), providers)
    await processPending(database, 'owner-a', processingAdapters)
    const existingInbox = database.prepare('SELECT inbox_id FROM inbox LIMIT 1').get() as { inbox_id: string }
    const adapter: CatscoAdapter = {
      me: async () => ({ uid: 'owner-a' }),
      findMessage: async () => null,
      sendExistingTopic: async () => { throw new Error('not used') },
      poll: async (topicId, cursor) => topicId === 'worker-topic' ? { observations: [{
        event: candidateEvent('ingest-failure'),
        attestation: { topicId, seqId: '17', senderUid: '559', serverReceivedAt: serverTime }
      }], nextCursor: '17' } : { observations: [], nextCursor: cursor ?? '0' }
    }
    await expect(reconcile(database, 'owner-a', adapter, { now: () => now, id: () => existingInbox.inbox_id }))
      .rejects.toThrow('UNIQUE constraint failed')
    expect(database.prepare('SELECT count(*) count FROM source_cursors').get()).toEqual({ count: 0 })
    database.close()
  })

  it('does not advance an earlier topic when a later topic poll fails', async () => {
    const database = db()
    ingest(database, 'owner-a', registration(), providers)
    await processPending(database, 'owner-a', processingAdapters)
    const observed = event('reconcile_tick', 'staged-before-failure', { scope: 'wi-1' })
    const adapter: CatscoAdapter = {
      me: async () => ({ uid: 'owner-a' }),
      findMessage: async () => null,
      sendExistingTopic: async () => { throw new Error('not used') },
      poll: async topicId => {
        if (topicId === 'steward-topic') throw new Error('poll failed')
        return { observations: [{ event: observed, attestation: {
          topicId, seqId: '1', senderUid: '559', serverReceivedAt: serverTime
        } }], nextCursor: '1' }
      }
    }
    await expect(reconcile(database, 'owner-a', adapter, providers)).rejects.toThrow('poll failed')
    expect(database.prepare("SELECT count(*) count FROM source_cursors WHERE scope_key='worker-topic'").get())
      .toEqual({ count: 0 })
    expect(database.prepare("SELECT count(*) count FROM inbox WHERE event_id='event-staged-before-failure'").get())
      .toEqual({ count: 0 })
    database.close()
  })

  it('advances an existing cursor to the durable end of a bounded page', async () => {
    const database = db()
    ingest(database, 'owner-a', registration(), providers)
    await processPending(database, 'owner-a', processingAdapters)
    database.prepare(`INSERT INTO source_cursors(owner_uid,source,scope_key,cursor_json,updated_at)
      VALUES('owner-a','catsco','worker-topic','"10"',?)`).run(now)
    const adapter = new OpenCliCatscoAdapter('opencli-test', queuedRunner([
      { uid: 'owner-a' },
      { items: [{ seqId: '11', topicId: 'worker-topic', senderUid: '559', content: 'ordinary chat', serverReceivedAt: serverTime }], nextCursor: '11', hasMore: true },
      { items: [], nextCursor: '0', hasMore: false }
    ], []))
    await expect(reconcile(database, 'owner-a', adapter, providers)).resolves.toMatchObject({ status: 'enqueued', observations: 0 })
    expect(database.prepare("SELECT cursor_json FROM source_cursors WHERE scope_key='worker-topic'").get())
      .toEqual({ cursor_json: '"11"' })
    database.close()
  })
})
