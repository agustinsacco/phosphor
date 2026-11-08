import type { OpenStoreOptions, SqliteDatabase } from './types'

export interface Context {
  db: SqliteDatabase
  now: () => number
  id: () => string
}
export type Bind = string | number | null | Uint8Array
export function all<T>(ctx: Context, sql: string, ...args: Bind[]): T[] {
  return ctx.db.prepare(sql).all(...args) as T[]
}
export function one<T>(ctx: Context, sql: string, ...args: Bind[]): T | undefined {
  return ctx.db.prepare(sql).get(...args) as T | undefined
}
export function run(ctx: Context, sql: string, ...args: Bind[]): void {
  ctx.db.prepare(sql).run(...args)
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
