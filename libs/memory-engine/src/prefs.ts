import { DEFAULT_BRAIN_PREFS, type BrainPrefs } from '@phosphor/shared/brain'
import { one, run, type Context } from './database'

export function prefs(ctx: Context): BrainPrefs {
  const row = one<{ value: string }>(ctx, "SELECT value FROM meta WHERE key='prefs'")
  return { ...DEFAULT_BRAIN_PREFS, ...(row ? (JSON.parse(row.value) as Partial<BrainPrefs>) : {}) }
}
export function setPrefs(ctx: Context, value: BrainPrefs): BrainPrefs {
  const merged = { ...prefs(ctx), ...value }
  run(ctx, "INSERT OR REPLACE INTO meta VALUES ('prefs', ?)", JSON.stringify(merged))
  return merged
}
export function revision(ctx: Context): number {
  return Number(one<{ value: string }>(ctx, "SELECT value FROM meta WHERE key='revision'")!.value)
}
export function bumpRevision(ctx: Context): void {
  run(ctx, "UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key='revision'")
}

/** Monotonic explicit keys keep incremental search correct even after deleting the last row. */
export function nextNumber(ctx: Context, table: 'entities' | 'memories'): number {
  const key = `${table}_sequence`
  const value = one<{ value: string }>(ctx, 'SELECT value FROM meta WHERE key=?', key)
  const next = value
    ? Number(value.value) + 1
    : (one<{ n: number }>(ctx, `SELECT MAX(n) AS n FROM ${table}`)?.n ?? 0) + 1
  run(ctx, 'INSERT OR REPLACE INTO meta VALUES (?,?)', key, String(next))
  return next
}
