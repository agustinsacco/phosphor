import {
  checkBrainNeverRead,
  checkBrainReaderModel,
  DEFAULT_BRAIN_PREFS,
  type BrainPrefs,
} from '@phosphor/shared/brain'
import { one, run, type Context } from './database'

/** A stored value is checked like a written one: a bad field reads as its default. */
export function prefs(ctx: Context): BrainPrefs {
  const row = one<{ value: string }>(ctx, "SELECT value FROM meta WHERE key='prefs'")
  const stored: unknown = row ? JSON.parse(row.value) : null
  if (!stored || typeof stored !== 'object' || Array.isArray(stored))
    return { ...DEFAULT_BRAIN_PREFS }
  const value = stored as Record<string, unknown>
  const flag = (key: 'enabled' | 'recall' | 'agentAuto'): boolean =>
    typeof value[key] === 'boolean' ? value[key] : DEFAULT_BRAIN_PREFS[key]
  return {
    enabled: flag('enabled'),
    recall: flag('recall'),
    agentAuto: flag('agentAuto'),
    model: storedModel(value.model),
    neverRead: storedNeverRead(value.neverRead),
  }
}
function storedModel(value: unknown): string | null {
  try {
    return checkBrainReaderModel(value ?? null)
  } catch {
    return null
  }
}
export function setPrefs(ctx: Context, value: BrainPrefs): BrainPrefs {
  checkBrainReaderModel(value.model)
  checkBrainNeverRead(value.neverRead)
  const merged = { ...prefs(ctx), ...value }
  run(ctx, "INSERT OR REPLACE INTO meta VALUES ('prefs', ?)", JSON.stringify(merged))
  return merged
}
export function revision(ctx: Context): number {
  return Number(one<{ value: string }>(ctx, "SELECT value FROM meta WHERE key='revision'")!.value)
}
/** Only stored knowledge changes make a read compare again; Tidy bookkeeping uses revision alone.
 * Seed lazily from the old counter so proposals made before this upgrade retain their meaning. */
export function knowledgeRevision(ctx: Context): number {
  const stored = one<{ value: string }>(
    ctx,
    "SELECT value FROM meta WHERE key='knowledge_revision'",
  )
  return stored ? Number(stored.value) : revision(ctx)
}
export function bumpKnowledgeRevision(ctx: Context): void {
  const next = knowledgeRevision(ctx) + 1
  run(ctx, "INSERT OR REPLACE INTO meta VALUES ('knowledge_revision', ?)", String(next))
  bumpRevision(ctx)
}
export function bumpRevision(ctx: Context): void {
  run(
    ctx,
    "INSERT OR IGNORE INTO meta VALUES ('knowledge_revision', ?)",
    String(knowledgeRevision(ctx)),
  )
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

function storedNeverRead(value: unknown): BrainPrefs['neverRead'] {
  try {
    return checkBrainNeverRead(value)
  } catch {
    return DEFAULT_BRAIN_PREFS.neverRead
  }
}
