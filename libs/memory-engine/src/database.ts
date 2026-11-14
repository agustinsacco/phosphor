import type { OpenStoreOptions, SqliteDatabase } from './types'

export interface Context {
  db: SqliteDatabase
  now: () => number
  id: () => string
}
export type Bind = string | number | null | Uint8Array
type Statement = ReturnType<SqliteDatabase['prepare']>

/**
 * Prepared statements per connection, oldest evicted first. Graph reads run the same few queries
 * hundreds of times; preparing each time cost more than running it. SQLite re-prepares a cached
 * statement by itself after a schema change, so a reset needs no invalidation.
 */
const STATEMENTS = new WeakMap<SqliteDatabase, Map<string, Statement>>()
const CACHED = 256
export function statement(ctx: Context, sql: string): Statement {
  let cache = STATEMENTS.get(ctx.db)
  if (!cache) STATEMENTS.set(ctx.db, (cache = new Map()))
  const cached = cache.get(sql)
  if (cached) return cached
  const prepared = ctx.db.prepare(sql)
  if (cache.size >= CACHED) cache.delete(cache.keys().next().value!)
  cache.set(sql, prepared)
  return prepared
}
export function all<T>(ctx: Context, sql: string, ...args: Bind[]): T[] {
  return statement(ctx, sql).all(...args) as T[]
}
export function one<T>(ctx: Context, sql: string, ...args: Bind[]): T | undefined {
  return statement(ctx, sql).get(...args) as T | undefined
}
export function run(ctx: Context, sql: string, ...args: Bind[]): void {
  statement(ctx, sql).run(...args)
}
export function transaction<T>(ctx: Context, action: () => T): T {
  ctx.db.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    ctx.db.exec('COMMIT')
    return result
  } catch (error) {
    ctx.db.exec('ROLLBACK')
    throw error
  }
}
export type { OpenStoreOptions }
