/**
 * The agent-control audit log over an injected SQLite handle: the daemon's
 * `state.sqlite`, or Desktop's `<userData>/agent-ops.sqlite` before migration.
 * The owner that opens the database runs `AGENT_OPS_SCHEMA` (created on every
 * open, no `user_version` change, like `lane_marks`). Rows arrive redacted
 * (`./redact`); the stored undo inverse is checked again here, so an inverse
 * that would need a secret is never stored and its row answers `undo: false`.
 * Retention: the newest 10,000 rows, none older than 90 days. Age is pruned on
 * every append; the row cap at open and every 100th append (it scans the cap).
 * Living contract: docs/agent-control.md.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { OP_APPLIES } from '@phosphor/shared/host-protocol-ops'
import { OP_SCOPES, OP_TIERS, type AgentOpRow, type AuditDecision } from '@phosphor/shared/ops'
import { redactsNothing } from './redact'
import type { AuditStore } from './types'

export const AGENT_OPS_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_ops (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, principal TEXT NOT NULL,
  lane_ref TEXT, lane_title TEXT, op TEXT NOT NULL, tier TEXT NOT NULL, scope TEXT NOT NULL,
  target TEXT, args_summary TEXT NOT NULL, reason TEXT, decision TEXT NOT NULL, result TEXT NOT NULL,
  applies TEXT, undo TEXT, undone_by TEXT, confirm_id TEXT, dialog_id TEXT, approved_by TEXT,
  batch_id TEXT, duration_ms INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS agent_ops_at ON agent_ops(at);
CREATE INDEX IF NOT EXISTS agent_ops_lane_at ON agent_ops(lane_ref, at);
`

export const AUDIT_LIMITS = {
  rows: 10_000,
  maxAgeMs: 90 * 24 * 60 * 60 * 1000,
  /** Rows one `list` returns at most. */
  page: 200,
  /** UTF-8 bytes of a stored undo inverse. */
  undoBytes: 64 * 1024,
  /** Appends between row-cap prunes. */
  capEvery: 100,
} as const

const DECISIONS: readonly AuditDecision[] = [
  'allowed',
  'approved',
  'denied-user',
  'timeout',
  'denied-policy',
  'denied-never',
  'denied-limit',
  'denied-user-off',
  'denied-unattended',
  'aborted',
]

/** The op that reverses an audited change, run as the user by Undo. */
export interface UndoRecord {
  readonly inverse: { readonly op: string; readonly args: Readonly<Record<string, unknown>> }
  /** The change's own args, kept only when redaction keeps every byte of them. */
  readonly forward?: Readonly<Record<string, unknown>>
}

/** What a row may carry beyond `AgentOpRow`. All optional, so a plain row still appends. */
export interface AuditExtras {
  /** Stored only with `undo: true` and only when it holds nothing redaction would remove. */
  readonly undoRecord?: UndoRecord | null
  readonly confirmId?: string
  readonly dialogId?: string
  readonly approvedBy?: string
  readonly batchId?: string
  readonly durationMs?: number
}

export type AuditEntry = AgentOpRow &
  Omit<AuditExtras, 'undoRecord'> & { readonly undoRecord: UndoRecord | null }

export interface AuditLog extends AuditStore {
  append(row: Omit<AgentOpRow, 'id'> & AuditExtras): Promise<string>
  get(id: string): AuditEntry | null
  /** Link a row to the change that undid it; false when it is unknown or already undone. */
  markUndone(id: string, undoneBy: string): boolean
  /** Apply retention now; returns the rows removed. */
  prune(): number
}

export interface AuditLogOptions {
  readonly now?: () => number
  readonly newId?: () => string
}

type Row = Record<string, unknown>
const member = <T extends string>(v: unknown, list: readonly T[]): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const optStr = <K extends string>(key: K, v: unknown): { [P in K]?: string } =>
  typeof v === 'string' ? ({ [key]: v } as { [P in K]: string }) : {}
const optNum = <K extends string>(key: K, v: unknown): { [P in K]?: number } =>
  typeof v === 'number' ? ({ [key]: v } as { [P in K]: number }) : {}

/** The stored inverse, or null when absent, unreadable or holding redactable material. */
function storableUndo(op: string, record: UndoRecord | null | undefined): string | null {
  if (!record || typeof record.inverse?.op !== 'string') return null
  if (!redactsNothing({ name: record.inverse.op }, record.inverse.args)) return null
  if (record.forward && !redactsNothing({ name: op }, record.forward)) return null
  const json = JSON.stringify(record)
  return Buffer.byteLength(json, 'utf8') <= AUDIT_LIMITS.undoBytes ? json : null
}

function readUndo(v: unknown): UndoRecord | null {
  if (typeof v !== 'string') return null
  try {
    const parsed = JSON.parse(v) as UndoRecord
    return typeof parsed?.inverse?.op === 'string' &&
      parsed.inverse.args !== null &&
      typeof parsed.inverse.args === 'object'
      ? parsed
      : null
  } catch {
    return null
  }
}

/** A row the file holds; null when a field is outside the contract (the file is user-writable). */
function entryFrom(r: Row): AuditEntry | null {
  const id = str(r.id)
  const principal = str(r.principal)
  const op = str(r.op)
  const argsSummary = str(r.args_summary)
  const result = str(r.result)
  if (!id || !principal || !op || argsSummary === undefined || result === undefined) return null
  if (typeof r.at !== 'number' || !member(r.tier, OP_TIERS) || !member(r.scope, OP_SCOPES))
    return null
  if (!member(r.decision, DECISIONS)) return null
  const applies = member(r.applies, OP_APPLIES) ? r.applies : undefined
  const undoRecord = readUndo(r.undo)
  return {
    id,
    at: r.at,
    principal,
    ...optStr('laneRef', r.lane_ref),
    ...optStr('laneTitle', r.lane_title),
    op,
    tier: r.tier,
    scope: r.scope,
    ...optStr('target', r.target),
    argsSummary,
    ...optStr('reason', r.reason),
    decision: r.decision,
    result,
    ...(applies ? { applies } : {}),
    undo: undoRecord !== null && r.undone_by === null,
    ...optStr('undoneBy', r.undone_by),
    undoRecord,
    ...optStr('confirmId', r.confirm_id),
    ...optStr('dialogId', r.dialog_id),
    ...optStr('approvedBy', r.approved_by),
    ...optStr('batchId', r.batch_id),
    ...optNum('durationMs', r.duration_ms),
  }
}

function withoutExtras(entry: AuditEntry): AgentOpRow {
  const {
    undoRecord: _u,
    confirmId: _c,
    dialogId: _d,
    approvedBy: _a,
    batchId: _b,
    durationMs: _m,
    ...row
  } = entry
  return row
}

const INSERT = `INSERT INTO agent_ops (id, at, principal, lane_ref, lane_title, op, tier, scope,
  target, args_summary, reason, decision, result, applies, undo, confirm_id, dialog_id, approved_by,
  batch_id, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

function insertValues(id: string, row: Omit<AgentOpRow, 'id'> & AuditExtras) {
  return [
    id,
    Math.floor(row.at),
    row.principal,
    row.laneRef ?? null,
    row.laneTitle ?? null,
    row.op,
    row.tier,
    row.scope,
    row.target ?? null,
    row.argsSummary,
    row.reason ?? null,
    row.decision,
    row.result,
    row.applies ?? null,
    row.undo ? storableUndo(row.op, row.undoRecord) : null,
    row.confirmId ?? null,
    row.dialogId ?? null,
    row.approvedBy ?? null,
    row.batchId ?? null,
    row.durationMs === undefined ? null : Math.round(row.durationMs),
  ]
}

function listRows(db: DatabaseSync, query: Parameters<AuditStore['list']>[0]): AgentOpRow[] {
  const limit = Math.max(1, Math.min(AUDIT_LIMITS.page, Math.floor(query.limit)))
  const where: string[] = []
  const params: (string | number)[] = []
  if (query.laneRef !== undefined) {
    where.push('lane_ref = ?')
    params.push(query.laneRef)
  }
  if (query.before !== undefined) {
    where.push('at < ?')
    params.push(query.before)
  }
  const rows = db
    .prepare(
      `SELECT * FROM agent_ops ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params, limit) as Row[]
  return rows.flatMap((r) => {
    const entry = entryFrom(r)
    return entry ? [withoutExtras(entry)] : []
  })
}

/** The audit log over `db`, whose owner has already run `AGENT_OPS_SCHEMA`. */
export function createAuditLog(db: DatabaseSync, options: AuditLogOptions = {}): AuditLog {
  const now = options.now ?? Date.now
  const newId = options.newId ?? randomUUID
  const insert = db.prepare(INSERT)
  const pruneAge = (): number =>
    Number(
      db.prepare('DELETE FROM agent_ops WHERE at < ?').run(now() - AUDIT_LIMITS.maxAgeMs).changes,
    )
  const prune = (): number => {
    const extra = db
      .prepare(
        `DELETE FROM agent_ops WHERE id IN
         (SELECT id FROM agent_ops ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
      )
      .run(AUDIT_LIMITS.rows)
    return pruneAge() + Number(extra.changes)
  }
  let sinceCap = 0
  prune()
  return {
    append(row) {
      const id = newId()
      insert.run(...insertValues(id, row))
      sinceCap += 1
      if (sinceCap >= AUDIT_LIMITS.capEvery) {
        sinceCap = 0
        prune()
      } else pruneAge()
      return Promise.resolve(id)
    },
    list: (query) => Promise.resolve(listRows(db, query)),
    get(id) {
      const row = db.prepare('SELECT * FROM agent_ops WHERE id = ?').get(id) as Row | undefined
      return row ? entryFrom(row) : null
    },
    markUndone(id, undoneBy) {
      const done = db
        .prepare('UPDATE agent_ops SET undone_by = ? WHERE id = ? AND undone_by IS NULL')
        .run(undoneBy, id)
      return Number(done.changes) === 1
    },
    prune,
  }
}
