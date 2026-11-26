import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentOpRow } from '@phosphor/shared/ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import { loadSqlite } from '../sqlite'
import {
  AGENT_OPS_SCHEMA,
  AUDIT_LIMITS,
  createAuditLog,
  type AuditExtras,
  type UndoRecord,
} from './audit'
import { auditInventory } from './meta-inventory'
import type { OpHandlerContext } from './types'
import { argsSummary } from './redact'

const DAY = 24 * 60 * 60 * 1000
const dbs: DatabaseSync[] = []
function openDb(): DatabaseSync {
  const db = new (loadSqlite().DatabaseSync)(':memory:')
  db.exec(AGENT_OPS_SCHEMA)
  dbs.push(db)
  return db
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

type Appended = Omit<AgentOpRow, 'id'> & AuditExtras
function row(at: number, patch: Partial<Appended> = {}): Appended {
  return {
    at,
    principal: 'agent:s1',
    laneRef: 'local/session:s1',
    laneTitle: 'Fix tests',
    op: 'lane.rename',
    tier: 'lane',
    scope: 'self',
    argsSummary: '{"name":"x"}',
    decision: 'allowed',
    result: 'ok',
    applies: 'now',
    undo: false,
    ...patch,
  }
}

function counter(start = 0) {
  let n = start
  return () => `id-${String(++n).padStart(6, '0')}`
}

describe('AGENT_OPS_SCHEMA', () => {
  it('creates the D3a agent_ops table, STRICT, and is safe to run on every open', () => {
    const db = openDb()
    db.exec(AGENT_OPS_SCHEMA)
    const columns = db.prepare('PRAGMA table_info(agent_ops)').all() as {
      name: string
      type: string
      notnull: number
      pk: number
    }[]
    expect(columns.map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}`)).toEqual([
      'id TEXT NOT NULL',
      'at INTEGER NOT NULL',
      'principal TEXT NOT NULL',
      'lane_ref TEXT',
      'lane_title TEXT',
      'op TEXT NOT NULL',
      'tier TEXT NOT NULL',
      'scope TEXT NOT NULL',
      'target TEXT',
      'args_summary TEXT NOT NULL',
      'reason TEXT',
      'decision TEXT NOT NULL',
      'result TEXT NOT NULL',
      'applies TEXT',
      'undo TEXT',
      'undone_by TEXT',
      'confirm_id TEXT',
      'dialog_id TEXT',
      'approved_by TEXT',
      'batch_id TEXT',
      'duration_ms INTEGER',
    ])
    expect(columns.find((c) => c.pk)?.name).toBe('id')
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_ops'").get() as {
      sql: string
    }
    expect(sql.sql).toMatch(/\)\s*STRICT$/)
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()
    expect(indexes.map((i) => (i as { name: string }).name).sort()).toEqual(
      expect.arrayContaining(['agent_ops_at', 'agent_ops_lane_at']),
    )
  })
})

describe('createAuditLog', () => {
  it('appends and lists newest first, by lane and before a time, with the extras on get', async () => {
    const log = createAuditLog(openDb(), { now: () => 10_000, newId: counter() })
    const first = await log.append(row(1000, { confirmId: 'c1', dialogId: 'd1', durationMs: 12.6 }))
    await log.append(row(2000, { laneRef: 'local/session:s2', reason: 'tidy' }))
    await log.append(row(3000))
    expect((await log.list({ limit: 10 })).map((r) => r.at)).toEqual([3000, 2000, 1000])
    expect((await log.list({ limit: 10, laneRef: 'local/session:s1' })).map((r) => r.at)).toEqual([
      3000, 1000,
    ])
    expect((await log.list({ limit: 1, before: 3000 })).map((r) => r.at)).toEqual([2000])
    const listed = (await log.list({ limit: 10 }))[2]
    expect(listed).toEqual({ id: first, ...row(1000) })
    expect(log.get(first)).toMatchObject({
      confirmId: 'c1',
      dialogId: 'd1',
      durationMs: 13,
      undoRecord: null,
    })
    expect(log.get('missing')).toBeNull()
  })

  it('never stores an MCP config’s headers, env, command or args anywhere in the row', async () => {
    const db = openDb()
    const log = createAuditLog(db, { now: () => 10 })
    const spec = OP_CATALOG.find((op) => op.name === 'mcp.add')
    if (!spec) throw new Error('mcp.add missing')
    const config = {
      command: '/opt/secret-cli',
      args: ['--key', 'ARG_SECRET'],
      env: { TOKEN: 'ENV_SECRET' },
      headers: { Authorization: 'Bearer HEADER_SECRET' },
    }
    await log.append(
      row(1, {
        op: 'mcp.add',
        argsSummary: argsSummary(spec, { name: 'n', scope: 'global', config }),
      }),
    )
    const stored = JSON.stringify(db.prepare('SELECT * FROM agent_ops').all())
    for (const secret of ['secret-cli', 'ARG_SECRET', 'ENV_SECRET', 'HEADER_SECRET'])
      expect(stored).not.toContain(secret)
  })

  it('stores a replayable inverse, and answers undo:false for one that needs a secret', async () => {
    const log = createAuditLog(openDb(), { now: () => 10 })
    const remove: UndoRecord = {
      inverse: { op: 'mcp.remove', args: { name: 'n', scope: 'global' } },
    }
    const kept = await log.append(row(1, { op: 'mcp.add', undo: true, undoRecord: remove }))
    expect(log.get(kept)).toMatchObject({ undo: true, undoRecord: remove })

    const secretInverses: UndoRecord[] = [
      {
        inverse: {
          op: 'mcp.update',
          args: { name: 'n', scope: 'global', config: { headers: { Authorization: 'x' } } },
        },
      },
      { inverse: { op: 'instructions.edit', args: { content: 'old text', revision: null } } },
      { inverse: { op: 'settings.set', args: { key: 'k', value: { apiToken: 't' } } } },
      { inverse: { op: 'lane.rename', args: { ref: 'r', name: 'a' } }, forward: { token: 's' } },
    ]
    for (const undoRecord of secretInverses) {
      const id = await log.append(row(2, { undo: true, undoRecord }))
      expect(log.get(id)).toMatchObject({ undo: false, undoRecord: null })
      expect((await log.list({ limit: 50 })).find((r) => r.id === id)?.undo).toBe(false)
    }
    const unasked = await log.append(row(3, { undo: false, undoRecord: remove }))
    expect(log.get(unasked)?.undoRecord).toBeNull()
  })

  it('links a row to its undo once', async () => {
    const log = createAuditLog(openDb(), { now: () => 10 })
    const id = await log.append(
      row(1, { undo: true, undoRecord: { inverse: { op: 'lane.rename', args: { ref: 'r' } } } }),
    )
    expect(log.markUndone(id, 'undo-1')).toBe(true)
    expect(log.markUndone(id, 'undo-2')).toBe(false)
    expect(log.markUndone('missing', 'undo-3')).toBe(false)
    expect(log.get(id)).toMatchObject({ undo: false, undoneBy: 'undo-1' })
  })

  it('keeps no row older than 90 days', async () => {
    let now = 100 * DAY
    const log = createAuditLog(openDb(), { now: () => now, newId: counter() })
    await log.append(row(now - 91 * DAY))
    await log.append(row(now - 89 * DAY))
    expect((await log.list({ limit: 10 })).map((r) => r.at)).toEqual([now - 89 * DAY])
    now += 2 * DAY
    expect(log.prune()).toBe(1)
    expect(await log.list({ limit: 10 })).toEqual([])
  })

  it('keeps the newest 10,000 rows', async () => {
    const db = openDb()
    const log = createAuditLog(db, { now: () => 1_000_000, newId: counter() })
    db.exec('BEGIN')
    for (let i = 0; i < AUDIT_LIMITS.rows + AUDIT_LIMITS.capEvery; i += 1)
      await log.append(row(1 + i))
    db.exec('COMMIT')
    const count = db.prepare('SELECT count(*) AS n FROM agent_ops').get() as { n: number }
    expect(count.n).toBe(AUDIT_LIMITS.rows)
    const oldest = db.prepare('SELECT min(at) AS at FROM agent_ops').get() as { at: number }
    expect(oldest.at).toBe(1 + AUDIT_LIMITS.capEvery)
  })

  it('skips a row the file holds outside the contract and clamps the page size', async () => {
    const db = openDb()
    const log = createAuditLog(db, { now: () => 1000, newId: counter() })
    await log.append(row(1))
    db.prepare("UPDATE agent_ops SET decision = 'yolo'").run()
    await log.append(row(2))
    expect((await log.list({ limit: 0 })).map((r) => r.at)).toEqual([2])
    expect(log.get('id-000001')).toBeNull()
    for (let i = 0; i < 205; i += 1) await log.append(row(3 + i))
    expect(await log.list({ limit: 1000 })).toHaveLength(AUDIT_LIMITS.page)
  })
})

it('walks byte-fitted keyset pages without picking up concurrent audit appends', async () => {
  const log = createAuditLog(openDb(), { now: () => 100, newId: counter() })
  const expected: string[] = []
  for (let i = 0; i < 5; i++)
    expected.unshift(await log.append(row(i, { argsSummary: '"😀'.repeat(1200) })))
  const seen: string[] = []
  const read = auditInventory(log)
  let page: string | undefined
  for (let i = 0; i < expected.length; i++) {
    const answer = await read({}, { page, principal: { kind: 'agent' } } as OpHandlerContext)
    expect(answer.text).toMatch(/^id \| at \| op \| decision \| laneRef \| result\n/)
    expect(Buffer.byteLength(JSON.stringify(answer.data))).toBeLessThanOrEqual(12 * 1024)
    expect(answer.next).toBe(expected[i + 1] === undefined ? undefined : expected[i])
    seen.push(...(answer.data as AgentOpRow[]).map(({ id }) => id))
    await log.append(row(100 + i, { op: 'audit.list' }))
    page = answer.next
    if (page === undefined) break
  }
  expect(seen).toEqual(expected)
})
