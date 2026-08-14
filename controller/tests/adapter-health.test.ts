import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { adapterHealthCommand, adapterHealthReport } from '../src/commands/adapter-health.js'
import type { CatscoAdapter } from '../src/adapters/catsco.js'
import type { LoopConfig } from '../src/config.js'
import { ProcessFailure } from '../src/lib/process.js'
import { openDatabase } from '../src/store/sqlite.js'
import { initializeOwner, migrate } from '../src/store/migrate.js'

const dirs: string[] = []
const config: LoopConfig = { ownerUid: '602', stateRoot: '/tmp/loopctl-health', opencliCommand: 'opencli', ghCommand: 'gh' }
const adapter = (overrides: Partial<CatscoAdapter> = {}): Pick<CatscoAdapter, 'me' | 'findMessage' | 'poll'> => ({
  me: async () => ({ uid: '602' }), findMessage: async () => null, poll: async () => ({ observations: [], nextCursor: '0' }), ...overrides
})

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function commandFixture(uid: string) {
  const dir = mkdtempSync(join(tmpdir(), 'loopctl-health-command-'))
  dirs.push(dir)
  const executable = join(dir, 'fake-opencli')
  writeFileSync(executable, `#!/bin/sh\nprintf '[{"uid":"${uid}"}]\\n'\n`)
  chmodSync(executable, 0o700)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...config, stateRoot: dir, opencliCommand: executable }))
  return dir
}

async function runCommandFixture(uid: string): Promise<{ output: string; exitCode: number | undefined }> {
  const root = commandFixture(uid)
  const previousRoot = process.env.LOOPCTL_STATE_ROOT
  const previousExitCode = process.exitCode
  const write = process.stdout.write
  let output = ''
  process.env.LOOPCTL_STATE_ROOT = root
  process.exitCode = undefined
  process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true }) as typeof process.stdout.write
  try {
    await adapterHealthCommand([])
    return { output, exitCode: process.exitCode }
  } finally {
    process.stdout.write = write
    process.exitCode = previousExitCode
    if (previousRoot === undefined) delete process.env.LOOPCTL_STATE_ROOT
    else process.env.LOOPCTL_STATE_ROOT = previousRoot
  }
}

describe('adapter health', () => {
  it('runs the production command through configured OpenCLI and emits its JSON exit contract', async () => {
    const healthy = await runCommandFixture('602')
    expect(JSON.parse(healthy.output)).toMatchObject({ healthy: true, classification: 'healthy', activeOwnerUid: '602' })
    expect(JSON.parse(healthy.output).stages).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'identity', status: 'passed' })]))
    expect(healthy.exitCode).toBeUndefined()
    const unhealthy = await runCommandFixture('603')
    expect(JSON.parse(unhealthy.output)).toMatchObject({ healthy: false, classification: 'owner_mismatch', activeOwnerUid: '603' })
    expect(unhealthy.exitCode).toBe(1)
  })

  it('preserves identity-only success by skipping unset optional probes', async () => {
    const report = await adapterHealthReport(config, adapter())
    expect(report).toMatchObject({ healthy: true, classification: 'healthy', stages: [
      { name: 'identity', status: 'passed' }, { name: 'poll', status: 'skipped' }, { name: 'receipt', status: 'skipped' }
    ] })
  })

  it('runs configured read-only poll and receipt probes without sending', async () => {
    let sends = 0
    const report = await adapterHealthReport({ ...config, healthPollTopicId: 'grp_101', healthPollAfterSeq: 7, healthReceiptTopicId: 'grp_102', healthReceiptClientMsgId: 'health-receipt-1' }, adapter({
      poll: async (topic, cursor) => { expect([topic, cursor]).toEqual(['grp_101', '7']); return { observations: [{ event: {}, attestation: { topicId: topic, seqId: '8', senderUid: '559', serverReceivedAt: '2026-08-01T00:00:00.000Z' } }], nextCursor: '8' } },
      findMessage: async (topic, clientMsgId) => { expect([topic, clientMsgId]).toEqual(['grp_102', 'health-receipt-1']); return { messageId: '1', clientMsgId, duplicate: false } },
      sendExistingTopic: async () => { sends += 1; throw new Error('must not send') }
    }))
    expect(report).toMatchObject({ healthy: true, stages: [
      { name: 'identity', status: 'passed' }, { name: 'poll', status: 'passed', observations: 1 }, { name: 'receipt', status: 'passed', found: true }
    ] })
    expect(sends).toBe(0)
  })

  it.each([
    ['identity', config, adapter({ me: async () => { throw new ProcessFailure('opencli timed out') } }), 'opencli_timeout'],
    ['poll', { ...config, healthPollTopicId: 'grp_101' }, adapter({ poll: async () => { throw new ProcessFailure('opencli exited 1', { stderr: 'Navigation rejected' }) } }), 'opencli_navigation_rejected'],
    ['receipt', { ...config, healthReceiptTopicId: 'grp_102', healthReceiptClientMsgId: 'health-receipt-1' }, adapter({ findMessage: async () => { throw new ProcessFailure('opencli exited 1', { stderr: 'CatsCo requires a logged-in session' }) } }), 'opencli_auth_required']
  ])('marks the first failed %s stage and fails closed', async (_name, probeConfig, catsco, classification) => {
    const report = await adapterHealthReport(probeConfig, catsco)
    expect(report).toMatchObject({ healthy: false, classification })
    expect(report.stages).toEqual(expect.arrayContaining([expect.objectContaining({ name: _name, status: 'failed', classification })]))
  })

  it.each([
    [async () => ({ observations: [], nextCursor: undefined } as unknown as any)],
    [async () => ({ observations: [{ event: {}, attestation: { topicId: 'grp_101', seqId: '', senderUid: '559', serverReceivedAt: 'invalid' } }], nextCursor: '1' } as unknown as any)]
  ])('fails closed on malformed poll envelopes', async poll => {
    await expect(adapterHealthReport({ ...config, healthPollTopicId: 'grp_101' }, adapter({ poll }))).resolves.toMatchObject({ healthy: false, classification: 'poll_malformed_result' })
  })

  it.each([
    [{ messageId: '', clientMsgId: 'x', duplicate: false }],
    [{ messageId: '1', clientMsgId: '', duplicate: false }],
    [{ messageId: '1', clientMsgId: 'x', duplicate: 'false' }]
  ])('fails closed on malformed receipt envelopes', async receipt => {
    await expect(adapterHealthReport({ ...config, healthReceiptTopicId: 'grp_102', healthReceiptClientMsgId: 'health-receipt-1' }, adapter({ findMessage: async () => receipt as any }))).resolves.toMatchObject({ healthy: false, classification: 'receipt_malformed_result' })
  })

  it('rejects unknown command arguments before reading configuration', async () => {
    await expect(adapterHealthCommand(['--unexpected'])).rejects.toThrow(/Unknown option/)
  })

  it('does not open or mutate semantic tables while checking transport health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loopctl-health-'))
    dirs.push(dir)
    const db = openDatabase(join(dir, 'loop.db'))
    migrate(db)
    initializeOwner(db, '602', '2026-08-01T00:00:00.000Z')
    const before = db.prepare("SELECT (SELECT count(*) FROM inbox) inbox, (SELECT count(*) FROM outbox) outbox, (SELECT count(*) FROM actions) actions, (SELECT count(*) FROM work_items) work_items").get()
    await adapterHealthReport({ ...config, stateRoot: dir, healthPollTopicId: 'grp_101', healthReceiptTopicId: 'grp_102', healthReceiptClientMsgId: 'health-receipt-1' }, adapter())
    const after = db.prepare("SELECT (SELECT count(*) FROM inbox) inbox, (SELECT count(*) FROM outbox) outbox, (SELECT count(*) FROM actions) actions, (SELECT count(*) FROM work_items) work_items").get()
    expect(after).toEqual(before)
    db.close()
  })
})
