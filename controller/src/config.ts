import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const configSchema = z.object({ ownerUid: z.string().min(1), stateRoot: z.string().min(1), opencliCommand: z.string().min(1).default('opencli'), ghCommand: z.string().min(1).default('gh') }).strict()
export type LoopConfig = z.infer<typeof configSchema>
export const defaultStateRoot = () => resolve(process.env.LOOPCTL_STATE_ROOT ?? join(homedir(), '.local', 'state', 'loopctl'))
export const configPath = (root = defaultStateRoot()) => join(root, 'config.json')
export const databasePath = (config: LoopConfig) => join(config.stateRoot, 'catsco', config.ownerUid, 'loop.db')
export async function saveConfig(config: LoopConfig): Promise<void> {
  const parsed = configSchema.parse(config); await mkdir(join(parsed.stateRoot, 'catsco', parsed.ownerUid), { recursive: true, mode: 0o700 })
  await writeFile(configPath(parsed.stateRoot), `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 }); await chmod(configPath(parsed.stateRoot), 0o600)
}
export async function loadConfig(root = defaultStateRoot()): Promise<LoopConfig> { return configSchema.parse(JSON.parse(await readFile(configPath(root), 'utf8'))) }
