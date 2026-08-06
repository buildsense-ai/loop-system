import { databasePath, loadConfig, type LoopConfig } from '../config.js'
import { OpenCliCatscoAdapter } from '../adapters/catsco-opencli.js'
import { openDatabase, type SqliteDatabase } from '../store/sqlite.js'
import { migrate } from '../store/migrate.js'

/** Resolve the owner namespace from the currently authenticated CatsCo session. */
export async function currentConfig(): Promise<LoopConfig> {
  const configured = await loadConfig()
  const { uid } = await new OpenCliCatscoAdapter(configured.opencliCommand).me()
  return { ...configured, ownerUid: uid }
}

export async function context(): Promise<{ config: LoopConfig; db: SqliteDatabase }> {
  const config = await currentConfig()
  const db = openDatabase(databasePath(config))
  migrate(db)
  return { config, db }
}

export const output = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
