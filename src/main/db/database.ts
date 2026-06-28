import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname } from 'path'
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js'
import { paths, ensureDir } from '../approvals/paths'

/**
 * SQLite via sql.js (WASM) — persistent, synchronous queries, no native deps.
 *
 * On startup we load the DB file from disk into memory. After every
 * write operation the caller must call `persist()` to flush to disk.
 * We also persist on app quit via `closeDb()`.
 */

let SQL: SqlJsStatic | null = null
let _db: SqlJsDatabase | null = null

function db(): SqlJsDatabase {
  if (!_db) throw new Error('DB not initialised — call initDb() first.')
  return _db
}

/** One-shot init: load WASM, open/create the DB file, run migrations. */
export async function initDb(): Promise<void> {
  SQL = await initSqlJs()
  ensureDir(paths.configDir) // ensures the parent dir exists

  if (existsSync(paths.dbFile)) {
    try {
      const buffer = readFileSync(paths.dbFile)
      _db = new SQL.Database(buffer)
    } catch (err) {
      console.error('[db] failed to load', paths.dbFile, err)
      _db = new SQL.Database()
    }
  } else {
    _db = new SQL.Database()
  }

  db().run('PRAGMA foreign_keys = ON;')
  runMigrations()
  persist()
}

/** Persist the in-memory DB to disk. Call after every mutation. */
export function persist(): void {
  if (!_db) return
  const buffer = _db.export()
  try {
    ensureDir(dirname(paths.dbFile))
    writeFileSync(paths.dbFile, Buffer.from(buffer))
  } catch (err) {
    console.error('[db] persist failed:', err)
  }
}

/** Close the DB (saves first). */
export function closeDb(): void {
  if (!_db) return
  persist()
  _db.close()
  _db = null
  SQL = null
}

// ─── query helpers ──────────────────────────────────────────────────────

/** Run a statement (INSERT / UPDATE / DELETE). Returns number of rows changed. */
export function run(sql: string, params: unknown[] = []): number {
  db().run(sql, params)
  return db().getRowsModified()
}

/** Run a SELECT and return rows as Record<string, unknown>[]. */
export function all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  const stmt = db().prepare(sql)
  try {
    stmt.bind(params)
    const rows: T[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as T)
    }
    return rows
  } finally {
    stmt.free()
  }
}

/** Run a SELECT and return the first row, or undefined. */
export function get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
  const stmt = db().prepare(sql)
  try {
    stmt.bind(params)
    if (stmt.step()) {
      return stmt.getAsObject() as unknown as T
    }
    return undefined
  } finally {
    stmt.free()
  }
}

// ─── migrations ─────────────────────────────────────────────────────────

function runMigrations(): void {
  const d = db()
  d.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      workspace_dir TEXT NOT NULL,
      default_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      default_protocol TEXT NOT NULL DEFAULT 'anthropic',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  d.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '新对话',
      model TEXT NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'anthropic',
      effort TEXT NOT NULL DEFAULT 'medium',
      base_url TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  d.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL DEFAULT '',
      thinking TEXT DEFAULT '',
      tool_calls_json TEXT NOT NULL DEFAULT '[]',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      usage_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `)
  d.run(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK(protocol IN ('anthropic','openai')),
      base_url TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL DEFAULT '',
      vision_mode TEXT NOT NULL DEFAULT 'text',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  // Post-hoc migrations: add columns that may not exist in older DBs.
  // sql.js throws on duplicate column — catch and ignore.
  try { d.run(`ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'`) } catch { /* column already exists */ }
  try { d.run(`ALTER TABLE messages ADD COLUMN usage_json TEXT NOT NULL DEFAULT '{}'`) } catch { /* column already exists */ }
  try { d.run(`ALTER TABLE models ADD COLUMN vision_mode TEXT NOT NULL DEFAULT 'text'`) } catch { /* column already exists */ }

  // Memories table (v2 — cross-session persistent memory)
  d.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('fact','preference','feedback','learning')),
      content TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '',
      importance INTEGER NOT NULL DEFAULT 5,
      source_session_id TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
}
