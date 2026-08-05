import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type SqliteDatabase = Database.Database
export function openDatabase(path: string): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path)
  db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); db.pragma('busy_timeout = 5000')
  return db
}
export function immediate<T>(db: SqliteDatabase, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const value = operation(); db.exec('COMMIT'); return value } catch (error) { if (db.inTransaction) db.exec('ROLLBACK'); throw error }
}
