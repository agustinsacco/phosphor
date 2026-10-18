import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type Receipt } from '@phosphor/shared/host-protocol'
import { loadSqlite } from '../sqlite'
import { SCHEMA } from '../schema'
import {
  beginRequest,
  finishRequest,
  getReceipt,
  markInterrupted,
  pruneReceipts,
  type ReceiptStoreContext,
} from './receipts'

let root: string
let db: DatabaseSync
let context: ReceiptStoreContext
let now: number
const clientId = randomUUID()
const hash = 'a'.repeat(64)
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'receipt-operations-'))
  const { DatabaseSync } = await loadSqlite()
  db = new DatabaseSync(join(root, 'state.sqlite'))
  db.exec(SCHEMA)
  now = 100
  context = {
    db,
    clock: vi.fn(() => now),
    ttl: 20,
    limits: { receiptsKept: 2, lanesPerHost: 2, repositoriesPerHost: 2 },
    isConnected: vi.fn(() => false),
    logCorruptReceipt: vi.fn(),
    transaction: <T>(fn: () => T): T => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  vi.spyOn(context, 'transaction')
})
afterEach(() => {
  vi.restoreAllMocks()
  db.close()
  rmSync(root, { recursive: true, force: true })
})
const start = (requestId: string = randomUUID()) => {
  expect(beginRequest(context, requestId, clientId, hash, null)).toEqual({ kind: 'new' })
  return requestId
}
const finish = (requestId: string) =>
  finishRequest(context, requestId, { requestId, status: 'done' })

it('prunes only strictly older finished receipts and leaves started rows independent', () => {
  const old = start()
  finish(old)
  now++
  const boundary = start()
  finish(boundary)
  const pending = start()
  now += context.ttl
  pruneReceipts(context, now)
  expect(getReceipt(context, old, clientId)).toBeNull()
  expect(getReceipt(context, boundary, clientId)).toEqual({ requestId: boundary, status: 'done' })
  expect(getReceipt(context, pending, clientId)).toEqual({ requestId: pending, status: 'pending' })
  now++
  expect(getReceipt(context, boundary, clientId)).toBeNull()
  expect(beginRequest(context, boundary, clientId, hash, null)).toEqual({ kind: 'new' })
  expect(beginRequest(context, randomUUID(), clientId, hash, null)).toEqual({ kind: 'busy' })
})
it('prunes tied completion times by request id, preserving exactly the cap and all started rows', () => {
  const ids = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
  ]
  for (const id of ids) {
    start(id)
    finish(id)
  }
  const pending = start()
  pruneReceipts(context, now)
  expect(
    db
      .prepare('SELECT request_id FROM receipts WHERE finished_at IS NOT NULL ORDER BY request_id')
      .all(),
  ).toEqual(ids.slice(1).map((request_id) => ({ request_id })))
  expect(getReceipt(context, pending, clientId)?.status).toBe('pending')
})
it('strips volatile connectivity from disk and rebuilds it through both read paths', () => {
  const requestId = start()
  const receipt: Receipt = {
    requestId,
    status: 'rejected',
    code: 'not-controller',
    control: { fence: 2, controller: { clientId, label: 'Historic', connected: true } },
  }
  finishRequest(context, requestId, receipt)
  const json = db.prepare('SELECT receipt_json FROM receipts').get()?.receipt_json
  expect(typeof json).toBe('string')
  expect(String(json)).not.toContain('connected')
  expect(getReceipt(context, requestId, clientId)).toEqual({
    ...receipt,
    control: { fence: 2, controller: { clientId, label: 'Historic', connected: false } },
  })
  context.isConnected = vi.fn(() => true)
  expect(beginRequest(context, requestId, clientId, hash, null)).toEqual({
    kind: 'existing',
    receipt,
  })
  finishRequest(context, requestId, receipt)
  expect(context.isConnected).toHaveBeenCalledWith(clientId)
})
it.each(['extra-field', 'persisted-connected'])(
  'hides %s corruption despite a lost logger and never reexecutes it',
  (kind) => {
    const requestId = start()
    finish(requestId)
    const corrupt =
      kind === 'extra-field'
        ? { requestId, status: 'done', private: 'not allowed' }
        : {
            requestId,
            status: 'rejected',
            code: 'not-controller',
            control: { fence: 1, controller: { clientId, label: 'Historic', connected: true } },
          }
    db.exec('PRAGMA ignore_check_constraints=ON')
    db.prepare('UPDATE receipts SET status=?,receipt_json=? WHERE request_id=?').run(
      corrupt.status,
      JSON.stringify(corrupt),
      requestId,
    )
    const log = vi.fn((_count: number) => {
      throw new Error('lost logger')
    })
    context.logCorruptReceipt = log
    expect(getReceipt(context, requestId, clientId)).toBeNull()
    expect(beginRequest(context, requestId, clientId, hash, null)).toEqual({
      kind: 'existing',
      receipt: { requestId, status: 'unknown' },
    })
    expect(beginRequest(context, requestId, randomUUID(), hash, null)).toEqual({ kind: 'conflict' })
    expect(log.mock.calls).toEqual([[1], [1], [1]])
    expect(db.prepare('SELECT receipt_json FROM receipts').get()?.receipt_json).toBe(
      JSON.stringify(corrupt),
    )
  },
)
it('drops only oversize receipt data and finishes idempotently without reading a later clock', () => {
  const requestId = start()
  const receipt: Receipt = {
    requestId,
    status: 'done',
    data: 'x'.repeat(HOST_LIMITS.receiptDataBytes),
  }
  finishRequest(context, requestId, receipt)
  expect(getReceipt(context, requestId, clientId)).toEqual({ requestId, status: 'done' })
  vi.mocked(context.clock).mockClear()
  finishRequest(context, requestId, receipt)
  expect(context.clock).not.toHaveBeenCalled()
  expect(() => finishRequest(context, requestId, { requestId, status: 'unknown' })).toThrow()
  expect(getReceipt(context, requestId, clientId)).toEqual({ requestId, status: 'done' })
})
it('clamps completion and recovery times to started_at after a clock rollback', () => {
  const done = start()
  const interrupted = start()
  now = 50
  finish(done)
  markInterrupted(context)
  expect(db.prepare('SELECT finished_at FROM receipts ORDER BY request_id').all()).toEqual([
    { finished_at: 100 },
    { finished_at: 100 },
  ])
  expect(getReceipt(context, interrupted, clientId)).toEqual({
    requestId: interrupted,
    status: 'unknown',
  })
})
it('takes exactly one writer transaction before prune and dedupe, without wrapping reads', async () => {
  const { DatabaseSync } = await loadSqlite()
  const competitor = new DatabaseSync(join(root, 'state.sqlite'))
  competitor.exec('PRAGMA busy_timeout=0')
  const prepare = db.prepare.bind(db)
  const operations: string[] = []
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    if (
      sql.startsWith('DELETE FROM receipts') ||
      sql === 'SELECT * FROM receipts WHERE request_id=?'
    ) {
      operations.push(sql.startsWith('DELETE') ? 'prune' : 'dedupe')
      expect(() => competitor.exec('BEGIN IMMEDIATE')).toThrow(/locked/)
    }
    return prepare(sql)
  })
  try {
    const requestId = start()
    expect(operations).toEqual(['prune', 'prune', 'dedupe'])
    expect(context.transaction).toHaveBeenCalledTimes(1)
    operations.length = 0
    expect(beginRequest(context, requestId, clientId, hash, null).kind).toBe('existing')
    expect(operations).toEqual(['prune', 'prune', 'dedupe'])
    expect(context.transaction).toHaveBeenCalledTimes(2)
    getReceipt(context, requestId, clientId)
    expect(context.transaction).toHaveBeenCalledTimes(2)
  } finally {
    competitor.close()
  }
})
