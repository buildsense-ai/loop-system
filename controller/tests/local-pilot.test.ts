import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLocalPilot } from '../src/commands/local-pilot.js'
import { openDatabase } from '../src/store/sqlite.js'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('deterministic local pilot', () => {
  it('runs the real accepted-terminal pipeline and retains inspectable state when requested', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'loopctl-local-pilot-test-'))
    dirs.push(stateRoot)

    const report = await runLocalPilot({ stateRoot, keepState: true })

    expect(report).toMatchObject({
      localOnly: true,
      stateRoot,
      finalState: { workItem: 'accepted', revision: 6, attempt: 'accepted' },
      actionCounts: { preflight_attempt: 1, execute_attempt: 1, review_candidate: 1, plan_next: 1 },
      candidateCount: 1,
      outbox: { total: 4, satisfied: 4 },
      runtimeStartedSource: 'simulated-control-bridge',
      idempotencyVerified: true
    })
    expect(report.cursorPositions).toEqual({
      grp_101: '3'
    })
    expect(report.sendSummary.map(item => [item.topicId, item.count])).toEqual([
      ['local-pilot-worker-topic', 2],
      ['p2p_574_602', 2]
    ])
    expect(report.livePrerequisites.requiredForLocalPilot).toEqual([])
    expect(statSync(join(stateRoot, 'config.json')).mode & 0o777).toBe(0o600)

    const db = openDatabase(String(report.databasePath))
    try {
      expect(db.prepare('SELECT state,revision FROM work_items').get()).toEqual({ state: 'accepted', revision: 6 })
      expect(db.prepare("SELECT count(*) count FROM inbox WHERE status='committed'").get()).toEqual({ count: 6 })
      expect(db.prepare("SELECT count(*) count FROM outbox WHERE state='satisfied'").get()).toEqual({ count: 4 })
      expect(db.prepare('SELECT count(*) count FROM effect_receipts').get()).toEqual({ count: 4 })
    } finally {
      db.close()
    }
  })

  it('removes state by default and can rerun at the same explicit root', async () => {
    const stateRoot = join(tmpdir(), `loopctl-local-pilot-rerun-${process.pid}-${Date.now()}`)

    const first = await runLocalPilot({ stateRoot })
    expect(first).toMatchObject({ stateRoot: 'removed', databasePath: 'removed', idempotencyVerified: true })
    expect(existsSync(stateRoot)).toBe(false)

    const second = await runLocalPilot({ stateRoot })
    expect(second).toEqual(first)
    expect(existsSync(stateRoot)).toBe(false)
  })
})
