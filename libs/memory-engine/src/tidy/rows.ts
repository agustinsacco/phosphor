import { createHash } from 'node:crypto'
import { all, one, type Bind, type Context } from '../database'

/** Only source rows belong in the journal; counts, FTS and sign bits are projections. */
export const rowKeys = {
  jobs: ['id'],
  proposals: ['job_id'],
  proposal_vectors: ['job_id', 'kind', 'idx'],
  extractions: ['job_id'],
  entities: ['n'],
  entity_names: ['n'],
  entity_keys: ['namespace', 'value'],
  entity_vectors: ['entity'],
  merges: ['n'],
  evidence: ['n'],
  memories: ['n'],
  mentions: ['memory', 'entity'],
  relations: ['n'],
  relation_support: ['relation', 'evidence', 'quote'],
  citations: ['memory', 'evidence', 'quote'],
  memory_links: ['source', 'target', 'kind'],
  memory_vectors: ['memory'],
} as const
export type RowTable = keyof typeof rowKeys
export type Row = Record<string, Bind>
export interface Image {
  version: 1
  key: Row
  row: Row | null
  /** A row the operation left unchanged: undo checks its hash and never writes it. */
  guard?: true
}
export type Rows = Map<RowTable, Map<string, Row>>
export interface Selection {
  entities: number[]
  memories: number[]
  jobs?: string[]
}
export function knownTable(table: string): table is RowTable {
  return Object.hasOwn(rowKeys, table)
}
export function keyOf(table: RowTable, row: Row): Row {
  return Object.fromEntries(rowKeys[table].map((key) => [key, row[key]!]))
}
export function rowKey(table: RowTable, row: Row): string {
  return rowKeys[table].map((key) => Buffer.from(String(row[key])).toString('hex')).join('.')
}
function json(row: Row | null): string {
  return JSON.stringify(
    row &&
      Object.fromEntries(
        Object.entries(row)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [
            key,
            value instanceof Uint8Array ? { base64: Buffer.from(value).toString('base64') } : value,
          ]),
      ),
  )
}
export function hash(row: Row | null): string | null {
  return row === null ? null : createHash('sha256').update(json(row)).digest('hex')
}
export function encodeImage(table: RowTable, key: Row, row: Row | null): string {
  return `{"version":1,"key":${json(keyOf(table, key))},"row":${json(row)}}`
}
export function encodeGuard(table: RowTable, key: Row): string {
  return `{"version":1,"key":${json(keyOf(table, key))},"row":null,"guard":true}`
}
export function columns(ctx: Context, table: RowTable): string[] {
  return all<{ name: string }>(ctx, `PRAGMA table_info(${table})`)
    .map((c) => c.name)
    .filter((c) => table !== 'entities' || !['memories', 'connections'].includes(c))
}
/** Reject unknown keys, malformed scalars and noncanonical blobs before any SQL is built. */
export function decodeImage(ctx: Context, table: RowTable, text: string): Image {
  const fail = (): never => {
    throw new Error('This Brain change has an unreadable undo record.')
  }
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object') return fail()
  const image = value as { version?: unknown; key?: unknown; row?: unknown; guard?: unknown }
  if (image.version !== 1) return fail()
  if (image.guard !== undefined && (image.guard !== true || image.row !== null)) return fail()
  const decode = (raw: unknown, expected: readonly string[]): Row => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail()
    const entries = Object.entries(raw)
    if (entries.length !== expected.length || entries.some(([k]) => !expected.includes(k)))
      return fail()
    return Object.fromEntries(
      entries.map(([k, v]: [string, unknown]) => {
        if (v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))
          return [k, v]
        if (
          k === 'vector' &&
          typeof v === 'object' &&
          v &&
          'base64' in v &&
          typeof v.base64 === 'string'
        ) {
          const blob = Buffer.from(v.base64, 'base64')
          if (blob.length === 768 * 4 && blob.toString('base64') === v.base64) return [k, blob]
        }
        return fail()
      }),
    )
  }
  const key = decode(image.key, rowKeys[table])
  const row = image.row === null ? null : decode(image.row, columns(ctx, table))
  if (row && rowKey(table, row) !== rowKey(table, key)) return fail()
  return image.guard ? { version: 1, key, row, guard: true } : { version: 1, key, row }
}
export function currentRow(ctx: Context, table: RowTable, key: Row): Row | null {
  return (
    one<Row>(
      ctx,
      `SELECT ${columns(ctx, table).join(',')} FROM ${table} WHERE ${rowKeys[table].map((k) => `${k}=?`).join(' AND ')}`,
      ...rowKeys[table].map((k) => key[k]!),
    ) ?? null
  )
}
/** Read approvals change entity metadata, but only the selected memories' neighbourhood. */
export function capture(
  ctx: Context,
  selection: Selection,
  only?: ReadonlySet<RowTable>,
  memoryScoped = false,
): Rows {
  const rows: Rows = new Map()
  const e = JSON.stringify(selection.entities),
    m = JSON.stringify(selection.memories)
  const select = (table: RowTable, where: string, ...args: Bind[]): Row[] => {
    if (only && !only.has(table)) {
      rows.set(table, new Map())
      return []
    }
    const found = all<Row>(
      ctx,
      `SELECT ${columns(ctx, table).join(',')} FROM ${table} WHERE ${where}`,
      ...args,
    )
    rows.set(table, new Map(found.map((row) => [rowKey(table, row), row])))
    return found
  }
  for (const table of [
    'entities',
    'entity_names',
    'entity_keys',
    'entity_vectors',
    'merges',
  ] as const)
    select(
      table,
      `${table === 'entities' ? 'n' : table === 'merges' ? 'target' : 'entity'} IN (SELECT value FROM json_each(?))`,
      e,
    )
  for (const table of ['memories', 'citations', 'memory_vectors'] as const)
    select(table, `${table === 'memories' ? 'n' : 'memory'} IN (SELECT value FROM json_each(?))`, m)
  select(
    'mentions',
    'entity IN (SELECT value FROM json_each(?)) OR memory IN (SELECT value FROM json_each(?))',
    memoryScoped ? '[]' : e,
    m,
  )
  const relations = select(
    'relations',
    'subject IN (SELECT value FROM json_each(?)) OR object IN (SELECT value FROM json_each(?)) OR memory IN (SELECT value FROM json_each(?))',
    memoryScoped ? '[]' : e,
    memoryScoped ? '[]' : e,
    m,
  )
  const support = select(
    'relation_support',
    'relation IN (SELECT value FROM json_each(?))',
    JSON.stringify(relations.map((r) => r.n)),
  )
  select(
    'memory_links',
    'source IN (SELECT value FROM json_each(?)) OR target IN (SELECT value FROM json_each(?))',
    m,
    m,
  )
  const evidence = [...(rows.get('citations')?.values() ?? []), ...support].map((r) => r.evidence)
  select('evidence', 'n IN (SELECT value FROM json_each(?))', JSON.stringify(evidence))
  for (const table of ['jobs', 'proposals', 'proposal_vectors', 'extractions'] as const)
    select(
      table,
      `${table === 'jobs' ? 'id' : 'job_id'} IN (SELECT value FROM json_each(?))`,
      JSON.stringify(selection.jobs ?? []),
    )
  return rows
}
