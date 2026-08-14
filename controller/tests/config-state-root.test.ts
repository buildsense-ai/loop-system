import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, saveConfig } from '../src/config.js'

const roots: string[] = []
afterEach(() => {
  delete process.env.LOOPCTL_REQUIRED_STATE_ROOT
  delete process.env.LOOPCTL_STATE_ROOT
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('production state-root policy', () => {
  it('refuses a config file whose selected root differs from its Ledger root', async () => {
    const selected = mkdtempSync(join(tmpdir(), 'loopctl-selected-')); roots.push(selected)
    const other = mkdtempSync(join(tmpdir(), 'loopctl-other-')); roots.push(other)
    writeFileSync(join(selected, 'config.json'), JSON.stringify({ ownerUid: '602', stateRoot: other, opencliCommand: 'opencli', ghCommand: 'gh' }))
    await expect(loadConfig(selected)).rejects.toThrow(/refusing split Ledger state/)
  })

  it('requires paired receipt probe configuration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loopctl-health-config-')); roots.push(root)
    writeFileSync(join(root, 'config.json'), JSON.stringify({ ownerUid: '602', stateRoot: root, healthReceiptTopicId: 'grp_101' }))
    await expect(loadConfig(root)).rejects.toThrow(/requires both topic and client message id/)
  })

  it('requires a poll topic when a poll cursor is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loopctl-health-config-')); roots.push(root)
    writeFileSync(join(root, 'config.json'), JSON.stringify({ ownerUid: '602', stateRoot: root, healthPollAfterSeq: 10 }))
    await expect(loadConfig(root)).rejects.toThrow(/health poll cursor requires a topic id/)
  })

  it('requires the configured root to equal the production root when pinned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loopctl-production-')); roots.push(root)
    process.env.LOOPCTL_REQUIRED_STATE_ROOT = root
    await saveConfig({ ownerUid: '602', stateRoot: root, opencliCommand: 'opencli', ghCommand: 'gh' })
    await expect(loadConfig(root)).resolves.toMatchObject({ ownerUid: '602', stateRoot: root })
    const other = mkdtempSync(join(tmpdir(), 'loopctl-wrong-')); roots.push(other)
    await expect(saveConfig({ ownerUid: '602', stateRoot: other, opencliCommand: 'opencli', ghCommand: 'gh' })).rejects.toThrow(/must be/)
  })
})
