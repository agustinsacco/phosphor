import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openStore, opHash, type HostStore } from './store'
import { loadSqlite } from './sqlite'

let root: string
let store: HostStore
let now: number
const clientId = randomUUID()
const laneId = randomUUID()
const hash = opHash({ type: 'lane.stop' })
const log = vi.fn((_count: number) => {
  throw new Error('lost logger')
})
async function open() {
  return openStore(join(root, 'state'), process.getuid?.(), {
    now: () => now,
    receiptTtlMs: 20,
    logCorruptReceipt: log,
  })
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'receipt-contract-'))
  now = 1000
  log.mockClear()
  store = await open()
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

it('deduplicates persisted request identity across reopen and never reveals conflicts', async () => {
  const requestId = randomUUID()
  const receipt = { requestId, status: 'done' as const, data: { private: 'result' } }
  expect(store.beginRequest(requestId, clientId, hash, laneId)).toEqual({ kind: 'new' })
  store.finishRequest(requestId, receipt)
  store.close()
  store = await open()
  expect(store.beginRequest(requestId, clientId, hash, laneId)).toEqual({
    kind: 'existing',
    receipt,
  })
  for (const [client, op, lane] of [
    [randomUUID(), hash, laneId],
    [clientId, opHash({ type: 'lane.resume' }), laneId],
    [clientId, hash, null],
  ] as const)
    expect(store.beginRequest(requestId, client, op, lane)).toEqual({ kind: 'conflict' })
  expect(store.getReceipt(requestId, randomUUID())).toBeNull()
})
it('excludes only older finished receipts at the exact TTL boundary without aging started rows', () => {
  const finished = randomUUID()
  const started = randomUUID()
  for (const requestId of [finished, started]) store.beginRequest(requestId, clientId, hash, null)
  now += 100
  store.finishRequest(finished, { requestId: finished, status: 'done' })
  now += 20
  store.pruneReceipts(now)
  expect(store.getReceipt(finished, clientId)).toEqual({ requestId: finished, status: 'done' })
  expect(store.beginRequest(finished, clientId, hash, null)).toMatchObject({ kind: 'existing' })
  now++
  expect(store.getReceipt(finished, clientId)).toBeNull()
  store.pruneReceipts(now)
  expect(store.beginRequest(finished, clientId, hash, null)).toEqual({ kind: 'new' })
  expect(store.beginRequest(started, clientId, hash, null)).toEqual({
    kind: 'existing',
    receipt: { requestId: started, status: 'pending' },
  })
})
it('finishes idempotently and never reexecutes a corrupt matching request even if logging fails', async () => {
  const requestId = randomUUID()
  const receipt = { requestId, status: 'done' as const }
  store.beginRequest(requestId, clientId, hash, null)
  store.finishRequest(requestId, receipt)
  store.finishRequest(requestId, receipt)
  expect(() => store.finishRequest(requestId, { requestId, status: 'unknown' })).toThrow()
  const { DatabaseSync } = await loadSqlite()
  const db = new DatabaseSync(join(root, 'state', 'state.sqlite'))
  try {
    const json = JSON.stringify({ requestId, status: 'done', unexpected: 'private value' })
    db.prepare('UPDATE receipts SET receipt_json=? WHERE request_id=?').run(json, requestId)
    expect(store.getReceipt(requestId, clientId)).toBeNull()
    expect(store.beginRequest(requestId, clientId, hash, null)).toEqual({
      kind: 'existing',
      receipt: { requestId, status: 'unknown' },
    })
    expect(store.beginRequest(requestId, randomUUID(), hash, null)).toEqual({ kind: 'conflict' })
    expect(log.mock.calls).toEqual([[1], [1], [1]])
    expect(
      db.prepare('SELECT receipt_json FROM receipts WHERE request_id=?').get(requestId)
        ?.receipt_json,
    ).toBe(json)
  } finally {
    db.close()
  }
})
