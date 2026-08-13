import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { adapterHealthCommand, adapterHealthReport } from '../src/commands/adapter-health.js'
import type { LoopConfig } from '../src/config.js'
import { ProcessFailure } from '../src/lib/process.js'
import { openDatabase } from '../src/store/sqlite.js'
import { initializeOwner, migrate } from '../src/store/migrate.js'

const dirs: string[] = []
const config: LoopConfig = { ownerUid: '602', stateRoot: '/tmp/loopctl-health', opencliCommand: 'opencli', ghCommand: 'gh' }
const owner = (uid: string) => ({ me: async () => ({ uid }) })
const failing = (error: Error) => ({ me: async () => { throw error } })

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
    expect(healthy.exitCode).toBeUndefined()

    const unhealthy = await runCommandFixture('603')
    expect(JSON.parse(unhealthy.output)).toMatchObject({ healthy: false, classification: 'owner_mismatch', activeOwnerUid: '603' })
    expect(unhealthy.exitCode).toBe(1)
  })

  it('rejects unknown command arguments before reading configuration', async () => {
    await expect(adapterHealthCommand(['--unexpected'])).rejects.toThrow(/Unknown option/)
  })

  it('reports a healthy OpenCLI owner only when it matches the configured namespace', async () => {
    await expect(adapterHealthReport(config, owner('602'))).resolves.toMatchObject({
      healthy: true, classification: 'healthy', configuredOwnerUid: '602', activeOwnerUid: '602'
    })
  })

  it('reports an authenticated owner mismatch without selecting a different namespace', async () => {
    await expect(adapterHealthReport(config, owner('603'))).resolves.toMatchObject({
      healthy: false, classification: 'owner_mismatch', configuredOwnerUid: '602', activeOwnerUid: '603'
    })
  })

  it.each([
    ['timeout', new ProcessFailure('opencli timed out'), 'opencli_timeout'],
    ['navigation rejection', new ProcessFailure('opencli exited 1', { stderr: 'Pre-navigation to https://app.catsco.cc/ failed: Navigation rejected.' }), 'opencli_navigation_rejected'],
    ['required login', new ProcessFailure('opencli exited 1', { stderr: 'CatsCo requires a logged-in session — open app.catsco.cc in Chrome and sign in.' }), 'opencli_auth_required'],
    ['nonzero command', new ProcessFailure('opencli exited 1', { stderr: 'server unavailable' }), 'opencli_command_failed'],
    ['malformed output', new SyntaxError('Unexpected token < in JSON at position 0'), 'opencli_malformed_output']
  ])('classifies OpenCLI %s failures', async (_name, error, classification) => {
    await expect(adapterHealthReport(config, failing(error))).resolves.toMatchObject({ healthy: false, classification })
  })

  it('does not mutate semantic tables while checking transport health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loopctl-health-'))
    dirs.push(dir)
    const db = openDatabase(join(dir, 'loop.db'))
    migrate(db)
    initializeOwner(db, '602', '2026-08-01T00:00:00.000Z')
    const before = db.prepare("SELECT (SELECT count(*) FROM inbox) inbox, (SELECT count(*) FROM outbox) outbox, (SELECT count(*) FROM actions) actions, (SELECT count(*) FROM work_items) work_items").get()
    await adapterHealthReport({ ...config, stateRoot: dir }, owner('602'))
    const after = db.prepare("SELECT (SELECT count(*) FROM inbox) inbox, (SELECT count(*) FROM outbox) outbox, (SELECT count(*) FROM actions) actions, (SELECT count(*) FROM work_items) work_items").get()
    expect(after).toEqual(before)
    db.close()
  })
})
