import { databasePath, loadConfig, type LoopConfig } from '../config.js'
import { openDatabase, type SqliteDatabase } from '../store/sqlite.js'
import { migrate } from '../store/migrate.js'

export async function context(): Promise<{ config: LoopConfig; db: SqliteDatabase }> {
  const config = await loadConfig()
  const db = openDatabase(databasePath(config))
  migrate(db)
  return { config, db }
}

export const output = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
