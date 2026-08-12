import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const configSchema = z.object({ ownerUid: z.string().min(1), stateRoot: z.string().min(1), opencliCommand: z.string().min(1).default('opencli'), ghCommand: z.string().min(1).default('gh') }).strict()
export type LoopConfig = z.infer<typeof configSchema>
export const defaultStateRoot = () => resolve(process.env.LOOPCTL_STATE_ROOT ?? join(homedir(), '.local', 'state', 'loopctl'))
export const requiredStateRoot = () => {
  const value = process.env.LOOPCTL_REQUIRED_STATE_ROOT?.trim()
  return value ? resolve(value) : null
}
function assertStateRoot(root: string): string {
  const resolved = resolve(root)
  const required = requiredStateRoot()
  if (required && resolved !== required) throw new Error(`Loop Controller state root must be ${required}; refusing split Ledger state at ${resolved}`)
  return resolved
}
export const configPath = (root = defaultStateRoot()) => join(resolve(root), 'config.json')
export const databasePath = (config: LoopConfig) => join(config.stateRoot, 'catsco', config.ownerUid, 'loop.db')
export async function saveConfig(config: LoopConfig): Promise<void> {
  const parsed = configSchema.parse(config)
  const stateRoot = assertStateRoot(parsed.stateRoot)
  await mkdir(join(stateRoot, 'catsco', parsed.ownerUid), { recursive: true, mode: 0o700 })
  const normalized = { ...parsed, stateRoot }
  await writeFile(configPath(stateRoot), `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 }); await chmod(configPath(stateRoot), 0o600)
}
export async function loadConfig(root = defaultStateRoot()): Promise<LoopConfig> {
  const selectedRoot = assertStateRoot(root)
  const config = configSchema.parse(JSON.parse(await readFile(configPath(selectedRoot), 'utf8')))
  const configuredRoot = assertStateRoot(config.stateRoot)
  if (configuredRoot !== selectedRoot) throw new Error(`Loop Controller config stateRoot ${configuredRoot} does not match selected state root ${selectedRoot}; refusing split Ledger state`)
  return { ...config, stateRoot: configuredRoot }
}
