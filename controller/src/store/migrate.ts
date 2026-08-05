import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SqliteDatabase } from './sqlite.js'
import { immediate } from './sqlite.js'

function migrationDirectory(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const path = resolve(moduleDir, '../../migrations')
  if (!existsSync(path)) throw new Error(`cannot locate package migrations directory: ${path}`)
  return path
}

export function migrate(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
  )`)
  const directory = migrationDirectory()
  const files = readdirSync(directory).filter(file => /^\d+_.*\.sql$/.test(file)).sort()
  for (const file of files) {
    const version = Number(file.split('_')[0])
    const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version)
    if (applied) continue
    immediate(db, () => {
      db.exec(readFileSync(resolve(directory, file), 'utf8'))
      db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(version, new Date().toISOString())
    })
  }
}

export function initializeOwner(db: SqliteDatabase, ownerUid: string, now = new Date().toISOString()): void {
  db.prepare('INSERT OR IGNORE INTO owner_namespaces(owner_uid,created_at) VALUES(?,?)').run(ownerUid, now)
}
