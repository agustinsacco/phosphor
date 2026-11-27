/**
 * Content digests for moving a Brain file to another owner. A digest covers every stored table
 * (ordinary tables and full-text tables, not their shadow or vocabulary tables) over a fixed
 * column projection, so a v7 source and its v8 upgrade compare on the columns they share. The
 * only differences `compareBrainHandover` accepts are the engine's own v7 → v8 steps:
 * added columns at their declared default, new tables as a fresh v8 file seeds them, reads that
 * waited for review back in the queue, and prefs rewritten with known keys.
 */
import { createHash } from 'node:crypto'
import type { BrainPrefs } from '@phosphor/shared/brain'
import type { Context } from './database'
import { prefs } from './prefs'
import { initialize } from './schema'
import type { SqliteDatabase } from './types'

export type BrainColumns = Readonly<Record<string, readonly string[]>>

export interface BrainTableDigest {
  readonly rows: number
  readonly sha256: string
}

export interface BrainHandoverCounts {
  readonly memories: number
  readonly entities: number
  readonly mentions: number
  readonly relations: number
  readonly endedRelations: number
  readonly evidence: number
  readonly jobs: number
  readonly suggestions: number
  readonly journal: number
  readonly runs: number
}

export interface BrainHandoverDigest {
  readonly schema: number
  readonly generation: string | null
  readonly columns: BrainColumns
  readonly tables: Readonly<Record<string, BrainTableDigest>>
  readonly prefs: BrainPrefs
  readonly counts: BrainHandoverCounts
}

type Row = Record<string, unknown>
const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`

export function brainSchemaVersion(db: SqliteDatabase): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
}

/** Stored tables and their columns; full-text tables add `rowid`, the key their rows keep. */
export function brainColumns(db: SqliteDatabase): BrainColumns {
  const tables = db
    .prepare(
      `SELECT l.name AS name, l.type AS type, m.sql AS sql FROM pragma_table_list AS l
       JOIN sqlite_master AS m ON m.name=l.name
       WHERE l.schema='main' AND l.type IN ('table','virtual') AND l.name NOT LIKE 'sqlite_%'
       ORDER BY l.name`,
    )
    .all() as { name: string; type: string; sql: string | null }[]
  const out: Record<string, string[]> = {}
  for (const table of tables) {
    const virtual = table.type === 'virtual'
    if (virtual && !/USING\s+fts5\s*\(/i.test(table.sql ?? '')) continue
    const names = (
      db.prepare('SELECT name FROM pragma_table_info(?)').all(table.name) as { name: string }[]
    ).map((column) => column.name)
    out[table.name] = virtual ? ['rowid', ...names] : names
  }
  return out
}

const encode = (value: unknown): unknown =>
  value instanceof Uint8Array ? { blob: Buffer.from(value).toString('base64') } : value

/** v7 reads waiting for review or refreshing return to the queue in v8 (schema.ts). */
function asV8Job(row: Row): Row {
  if (row.state !== 'review' && row.state !== 'refreshing') return row
  const out: Row = { ...row, state: 'queued' }
  for (const key of ['run_started_at', 'error', 'progress']) if (key in out) out[key] = null
  return out
}

function tableDigest(
  db: SqliteDatabase,
  table: string,
  names: readonly string[],
  upgradeV7: boolean,
): BrainTableDigest {
  const list = names.map(quoteName).join(',')
  const order = names.map((_, i) => String(i + 1)).join(',')
  // `prefs` is compared by meaning: an upgrade rewrites it with the known keys.
  const where = table === 'meta' ? " WHERE key <> 'prefs'" : ''
  const hash = createHash('sha256')
  let rows = 0
  const statement = db.prepare(`SELECT ${list} FROM ${quoteName(table)}${where} ORDER BY ${order}`)
  for (const raw of statement.iterate() as Iterable<Row>) {
    const row = upgradeV7 && table === 'jobs' ? asV8Job(raw) : raw
    hash.update(JSON.stringify(names.map((name) => encode(row[name]))))
    hash.update('\n')
    rows++
  }
  return { rows, sha256: hash.digest('hex') }
}

function count(db: SqliteDatabase, sql: string): number {
  try {
    return Number((db.prepare(sql).get() as { n: number }).n)
  } catch {
    return 0
  }
}

function counts(db: SqliteDatabase): BrainHandoverCounts {
  const n = (table: string, where = '') =>
    count(db, `SELECT COUNT(*) AS n FROM ${quoteName(table)}${where}`)
  return {
    memories: n('memories'),
    entities: n('entities'),
    mentions: n('mentions'),
    relations: n('relations'),
    endedRelations: n('relations', ' WHERE live=0'),
    evidence: n('evidence'),
    jobs: n('jobs'),
    suggestions: n('tidy_suggestions'),
    journal: n('tidy_operations'),
    runs: n('agent_runs'),
  }
}

/**
 * The digest of `db` over `projection` (default: every stored column it has). With `upgradeV7`
 * the v7 → v8 job reset is applied first, so a v7 source digests as its upgrade should.
 */
export function brainHandoverDigest(
  db: SqliteDatabase,
  options: { projection?: BrainColumns; upgradeV7?: boolean } = {},
): BrainHandoverDigest {
  const columns = options.projection ?? brainColumns(db)
  const tables: Record<string, BrainTableDigest> = {}
  for (const [table, names] of Object.entries(columns))
    tables[table] = tableDigest(db, table, names, options.upgradeV7 === true)
  const ctx = { db, now: Date.now, id: () => '' } as Context
  const generation = db.prepare("SELECT value FROM meta WHERE key='generation'").get() as
    { value: string } | undefined
  return {
    schema: brainSchemaVersion(db),
    generation: generation?.value ?? null,
    columns,
    tables,
    prefs: prefs(ctx),
    counts: counts(db),
  }
}

/** A declared default the comparison can test safely: NULL, an integer or a plain string. */
const SAFE_DEFAULT = /^(NULL|-?\d+|'[^']*')$/i

function addedColumnProblems(
  db: SqliteDatabase,
  table: string,
  shared: readonly string[],
): string[] {
  const all = db
    .prepare('SELECT name, dflt_value AS dflt FROM pragma_table_info(?)')
    .all(table) as { name: string; dflt: string | null }[]
  const problems: string[] = []
  for (const column of all) {
    if (shared.includes(column.name)) continue
    const dflt = column.dflt ?? 'NULL'
    if (!SAFE_DEFAULT.test(dflt)) {
      problems.push(`${table}.${column.name}: unexpected default`)
      continue
    }
    const changed = count(
      db,
      `SELECT COUNT(*) AS n FROM ${quoteName(table)} WHERE ${quoteName(column.name)} IS NOT ${dflt}`,
    )
    if (changed > 0) problems.push(`${table}.${column.name}: not at its default`)
  }
  return problems
}

/** What a fresh v8 file holds in each table: the rows an upgrade may seed. */
function freshDigest(Database: new (path: string) => SqliteDatabase): BrainHandoverDigest {
  const db = new Database(':memory:')
  try {
    initialize({ db, now: Date.now, id: () => '' })
    return brainHandoverDigest(db)
  } finally {
    db.close()
  }
}

/**
 * Differences between a source and its upgraded copy, as readable problems; empty when the
 * copy holds the same content. `source` is the digest of the pre-upgrade file with `upgradeV7`.
 */
export function compareBrainHandover(
  source: BrainHandoverDigest,
  target: SqliteDatabase,
  Database: new (path: string) => SqliteDatabase,
): string[] {
  const problems: string[] = []
  const targetColumns = brainColumns(target)
  for (const [table, names] of Object.entries(source.columns)) {
    const have = targetColumns[table]
    if (!have) {
      problems.push(`${table}: missing`)
      continue
    }
    const lost = names.filter((name) => !have.includes(name))
    if (lost.length > 0) problems.push(`${table}: lost ${lost.join(',')}`)
    else if (have.length > names.length) problems.push(...addedColumnProblems(target, table, names))
  }
  const digest = brainHandoverDigest(target, { projection: source.columns })
  for (const [table, expected] of Object.entries(source.tables)) {
    const found = digest.tables[table]
    if (found && (found.rows !== expected.rows || found.sha256 !== expected.sha256))
      problems.push(`${table}: content differs`)
  }
  const added = Object.keys(targetColumns).filter((table) => !(table in source.columns))
  if (added.length > 0) {
    if (source.schema >= 8) problems.push(`unexpected tables: ${added.join(',')}`)
    else {
      const fresh = freshDigest(Database)
      const now = brainHandoverDigest(target, {
        projection: Object.fromEntries(added.map((t) => [t, targetColumns[t]!])),
      })
      for (const table of added)
        if (now.tables[table]?.sha256 !== fresh.tables[table]?.sha256)
          problems.push(`${table}: not as a new Brain seeds it`)
    }
  }
  if (JSON.stringify(digest.prefs) !== JSON.stringify(source.prefs)) problems.push('prefs: differ')
  if (source.schema >= 8 && digest.schema !== source.schema) problems.push('schema: changed')
  return problems
}
