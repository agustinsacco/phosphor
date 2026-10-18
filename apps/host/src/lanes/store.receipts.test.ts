import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type Receipt } from '@phosphor/shared/host-protocol'
import { loadSqlite } from './sqlite'
import { openStore, opHash, type HostStore } from './store'

let root: string
let directory: string
let store: HostStore
let repositoryId: string
let now: number
const handles: HostStore[] = []
const uid = process.getuid?.()
const one = { clientId: randomUUID(), label: 'One' }
const two = { clientId: randomUUID(), label: 'Two' }
const hash = opHash({ type: 'lane.stop' })
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'host-store-receipts-'))
  directory = join(root, 'state')
  now = 1000
  store = await openStore(directory, uid, {
    now: () => now,
    limits: { receiptsKept: 5, lanesPerHost: 5, repositoriesPerHost: 5 },
  })
  handles.push(store)
  const repository = join(root, 'repository')
  mkdirSync(repository)
  const [entry] = store.syncRepositories([repository])
  if (!entry) throw new Error('missing repository')
  repositoryId = entry.id
})
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  rmSync(root, { recursive: true, force: true })
})
const lane = (sessionFile: string | null = join(root, 'file.jsonl')) =>
  store.ensureLane({ repositoryId, cwd: join(root, 'repository'), sessionFile })
async function reopen() {
  store.close()
  handles.splice(handles.indexOf(store), 1)
  store = await openStore(directory, uid, {
    now: () => now,
    limits: { receiptsKept: 5, lanesPerHost: 5, repositoriesPerHost: 5 },
  })
  handles.push(store)
}

describe('Host store ordering and durability', () => {
  it('accepts only positive safe integer receipt TTLs no longer than the contract', async () => {
    for (const receiptTtlMs of [1, HOST_LIMITS.receiptTtlMs]) {
      const handle = await openStore(join(root, `ttl-${receiptTtlMs}`), uid, { receiptTtlMs })
      handles.push(handle)
    }
    for (const receiptTtlMs of [0, -1, 0.5, NaN, Infinity, HOST_LIMITS.receiptTtlMs + 1])
      await expect(
        openStore(join(root, `ttl-${receiptTtlMs}`), uid, { receiptTtlMs }),
      ).rejects.toThrow()
  })
  it('uses the lowered TTL on reads, admission and pruning without aging started receipts', async () => {
    const handle = await openStore(join(root, 'short-ttl'), uid, {
      now: () => now,
      receiptTtlMs: 20,
    })
    handles.push(handle)
    const read = randomUUID(),
      pruned = randomUUID(),
      started = randomUUID()
    for (const requestId of [read, pruned, started])
      handle.beginRequest(requestId, one.clientId, hash, null)
    now += 100
    for (const requestId of [read, pruned])
      handle.finishRequest(requestId, { requestId, status: 'done' })
    now += 20
    handle.pruneReceipts(now)
    expect(handle.getReceipt(read, one.clientId)).toEqual({ requestId: read, status: 'done' })
    expect(handle.getReceipt(pruned, one.clientId)).toEqual({ requestId: pruned, status: 'done' })
    expect(handle.beginRequest(read, one.clientId, hash, null)).toMatchObject({ kind: 'existing' })
    now++
    expect(handle.getReceipt(read, one.clientId)).toBeNull()
    expect(handle.beginRequest(read, one.clientId, hash, null)).toEqual({ kind: 'new' })
    handle.pruneReceipts(now)
    expect(handle.getReceipt(pruned, one.clientId)).toBeNull()
    expect(handle.beginRequest(started, one.clientId, hash, null)).toEqual({
      kind: 'existing',
      receipt: { requestId: started, status: 'pending' },
    })
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(root, 'short-ttl', 'state.sqlite'))
    try {
      expect(
        db.prepare('SELECT request_id FROM receipts WHERE request_id=?').get(pruned),
      ).toBeUndefined()
    } finally {
      db.close()
    }
  })
  it('deduplicates requests, refuses other op/client/lane, and recovers unfinished as unknown', async () => {
    const id = lane().laneId
    const requestId = randomUUID()
    expect(store.beginRequest(requestId, one.clientId, hash, id)).toEqual({ kind: 'new' })
    expect(store.beginRequest(requestId, one.clientId, hash, id)).toEqual({
      kind: 'existing',
      receipt: { requestId, status: 'pending' },
    })
    expect(store.beginRequest(requestId, two.clientId, hash, id)).toEqual({ kind: 'conflict' })
    expect(
      store.beginRequest(requestId, one.clientId, opHash({ type: 'lane.resume' }), id),
    ).toEqual({ kind: 'conflict' })
    expect(store.beginRequest(requestId, one.clientId, hash, null)).toEqual({ kind: 'conflict' })
    await reopen()
    expect(store.beginRequest(requestId, one.clientId, hash, id)).toEqual({
      kind: 'existing',
      receipt: { requestId, status: 'unknown' },
    })
    expect(() => store.finishRequest(requestId, { requestId, status: 'done' })).toThrow()
  })
  it('keeps one terminal receipt and drops only oversize data, including UTF-8 byte boundaries', () => {
    for (const bytes of [HOST_LIMITS.receiptDataBytes, HOST_LIMITS.receiptDataBytes + 1]) {
      const requestId = randomUUID()
      store.beginRequest(requestId, one.clientId, hash, null)
      const receipt: Receipt = {
        requestId,
        status: 'done',
        data: 'é'.repeat((bytes - 2) / 2) + (bytes % 2 ? 'a' : ''),
      }
      store.finishRequest(requestId, receipt)
      const existing = store.beginRequest(requestId, one.clientId, hash, null)
      expect(existing).toEqual({
        kind: 'existing',
        receipt: bytes === HOST_LIMITS.receiptDataBytes ? receipt : { requestId, status: 'done' },
      })
      store.finishRequest(requestId, receipt)
      expect(() => store.finishRequest(requestId, { requestId, status: 'unknown' })).toThrow()
    }
    const requestId = randomUUID()
    store.beginRequest(requestId, one.clientId, hash, null)
    expect(() => store.finishRequest(requestId, { requestId, status: 'pending' })).toThrow()
  })
  it('keeps receipt controllers historic but rebuilds connected through both read paths', async () => {
    let connected = true
    const other = await openStore(directory, uid, { now: () => now, isConnected: () => connected })
    handles.push(other)
    const id = lane().laneId
    const requestId = randomUUID()
    const receipt: Receipt = {
      requestId,
      status: 'rejected',
      code: 'not-controller',
      control: { fence: 2, controller: { ...one, connected: true } },
    }
    other.beginRequest(requestId, one.clientId, hash, id)
    other.finishRequest(requestId, receipt)
    expect(other.getReceipt(requestId, one.clientId)).toEqual(receipt)
    other.takeControl(id, two)
    connected = false
    const current = { ...receipt, control: { fence: 2, controller: { ...one, connected: false } } }
    expect(other.beginRequest(requestId, one.clientId, hash, id)).toEqual({
      kind: 'existing',
      receipt: current,
    })
    expect(other.getReceipt(requestId, one.clientId)).toEqual(current)
    other.finishRequest(requestId, receipt)
    other.finishRequest(requestId, current)
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    try {
      const json = db
        .prepare('SELECT receipt_json FROM receipts WHERE request_id=?')
        .get(requestId)?.receipt_json
      expect(typeof json).toBe('string')
      if (typeof json !== 'string') throw new Error('missing receipt JSON')
      expect(json).not.toContain('connected')
    } finally {
      db.close()
    }
  })
  it('reads receipts without revealing other clients and agrees with admission at the TTL boundary', () => {
    const requestId = randomUUID()
    const oldStarted = randomUUID()
    expect(store.getReceipt(requestId, one.clientId)).toBeNull()
    store.beginRequest(requestId, one.clientId, hash, null)
    store.beginRequest(oldStarted, one.clientId, hash, null)
    expect(store.getReceipt(requestId, two.clientId)).toBeNull()
    expect(store.getReceipt(requestId, one.clientId)).toEqual({ requestId, status: 'pending' })
    const receipt: Receipt = { requestId, status: 'done' }
    store.finishRequest(requestId, receipt)
    now += HOST_LIMITS.receiptTtlMs
    expect(store.getReceipt(requestId, one.clientId)).toEqual(receipt)
    expect(store.beginRequest(requestId, one.clientId, hash, null)).toEqual({
      kind: 'existing',
      receipt,
    })
    now++
    expect(store.getReceipt(requestId, one.clientId)).toBeNull()
    expect(store.beginRequest(requestId, one.clientId, hash, null)).toEqual({ kind: 'new' })
    expect(store.getReceipt(oldStarted, one.clientId)).toEqual({
      requestId: oldStarted,
      status: 'pending',
    })
    expect(store.beginRequest(oldStarted, one.clientId, hash, null)).toEqual({
      kind: 'existing',
      receipt: { requestId: oldStarted, status: 'pending' },
    })
  })
  it('logs corrupt receipt counts, hides them on reads and never re-executes a matching request', async () => {
    const log = vi.fn()
    const other = await openStore(directory, uid, { now: () => now, logCorruptReceipt: log })
    handles.push(other)
    const requestId = randomUUID()
    other.beginRequest(requestId, one.clientId, hash, null)
    other.finishRequest(requestId, {
      requestId,
      status: 'failed',
      error: { code: 'internal', message: 'Failed' },
    })
    const json = JSON.stringify({
      requestId,
      status: 'failed',
      error: { code: 'other', message: 'private corrupt content' },
    })
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    try {
      db.prepare('UPDATE receipts SET receipt_json=? WHERE request_id=?').run(json, requestId)
      expect(other.getReceipt(requestId, two.clientId)).toBeNull()
      expect(other.getReceipt(requestId, one.clientId)).toBeNull()
      expect(other.beginRequest(requestId, one.clientId, hash, null)).toEqual({
        kind: 'existing',
        receipt: { requestId, status: 'unknown' },
      })
      expect(other.beginRequest(requestId, two.clientId, hash, null)).toEqual({ kind: 'conflict' })
      expect(log.mock.calls).toEqual([[1], [1], [1]])
      log.mockImplementationOnce(() => {
        throw new Error('private logger failure')
      })
      expect(other.getReceipt(requestId, one.clientId)).toBeNull()
      expect(
        db.prepare('SELECT receipt_json FROM receipts WHERE request_id=?').get(requestId)
          ?.receipt_json,
      ).toBe(json)
    } finally {
      db.close()
    }
  })
  it('ages finished receipts from completion, keeping exactly 24 hours and every started row', async () => {
    const done = randomUUID()
    const interrupted = randomUUID()
    store.beginRequest(done, one.clientId, hash, null)
    store.beginRequest(interrupted, one.clientId, hash, null)
    now += HOST_LIMITS.receiptTtlMs
    store.finishRequest(done, { requestId: done, status: 'done' })
    await reopen()
    const started = randomUUID()
    store.beginRequest(started, one.clientId, hash, null)
    store.pruneReceipts(now + HOST_LIMITS.receiptTtlMs)
    expect(store.beginRequest(done, one.clientId, hash, null)).toMatchObject({
      kind: 'existing',
      receipt: { status: 'done' },
    })
    expect(store.beginRequest(interrupted, one.clientId, hash, null)).toMatchObject({
      kind: 'existing',
      receipt: { status: 'unknown' },
    })
    store.pruneReceipts(now + HOST_LIMITS.receiptTtlMs + 1)
    expect(store.beginRequest(done, one.clientId, hash, null).kind).toBe('new')
    expect(store.beginRequest(interrupted, one.clientId, hash, null).kind).toBe('new')
    expect(store.beginRequest(started, one.clientId, hash, null)).toMatchObject({
      kind: 'existing',
      receipt: { status: 'pending' },
    })
  })
  it('bounds started rows independently of finished rows and returns busy without recording', async () => {
    const done = randomUUID()
    store.beginRequest(done, one.clientId, hash, null)
    store.finishRequest(done, { requestId: done, status: 'done' })
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    try {
      db.exec('BEGIN IMMEDIATE')
      const insert = db.prepare("INSERT INTO receipts VALUES (?,?,?,NULL,'started',NULL,?,NULL)")
      for (let count = 0; count < store.limits.receiptsKept - 1; count++)
        insert.run(randomUUID(), one.clientId, hash, now)
      db.exec('COMMIT')
      expect(store.beginRequest(randomUUID(), one.clientId, hash, null).kind).toBe('new')
      const busy = randomUUID()
      expect(store.beginRequest(busy, one.clientId, hash, null)).toEqual({ kind: 'busy' })
      expect(db.prepare('SELECT * FROM receipts WHERE request_id=?').get(busy)).toBeUndefined()
      store.pruneReceipts(now + HOST_LIMITS.receiptTtlMs + 1)
      expect(store.beginRequest(busy, one.clientId, hash, null)).toEqual({ kind: 'busy' })
      expect(db.prepare("SELECT count(*) AS n FROM receipts WHERE status='started'").get()?.n).toBe(
        store.limits.receiptsKept,
      )
    } finally {
      db.close()
    }
  })
  it('bounds finished receipts during finish, removing the oldest and preserving started rows', async () => {
    const oldest = randomUUID()
    const started = randomUUID()
    store.beginRequest(oldest, one.clientId, hash, null)
    store.finishRequest(oldest, { requestId: oldest, status: 'done' })
    store.beginRequest(started, one.clientId, hash, null)
    for (let count = 0; count < store.limits.receiptsKept; count++) {
      now++
      const requestId = randomUUID()
      store.beginRequest(requestId, one.clientId, hash, null)
      store.finishRequest(requestId, { requestId, status: 'done' })
    }
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    try {
      expect(
        db.prepare('SELECT count(*) AS n FROM receipts WHERE finished_at IS NOT NULL').get()?.n,
      ).toBe(store.limits.receiptsKept)
    } finally {
      db.close()
    }
    expect(store.getReceipt(oldest, one.clientId)).toBeNull()
    expect(store.beginRequest(oldest, one.clientId, hash, null).kind).toBe('new')
    expect(store.beginRequest(started, one.clientId, hash, null)).toMatchObject({
      kind: 'existing',
      receipt: { status: 'pending' },
    })
  })
  it('prunes exactly to the finished cap, counting unknown but not started rows', async () => {
    const started = randomUUID()
    const unknown = randomUUID()
    store.beginRequest(started, one.clientId, hash, null)
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    try {
      db.exec('BEGIN IMMEDIATE')
      const insert = db.prepare("INSERT INTO receipts VALUES (?,?,?,NULL,'unknown',?,?,?)")
      insert.run(
        unknown,
        one.clientId,
        hash,
        JSON.stringify({ requestId: unknown, status: 'unknown' }),
        now,
        now,
      )
      for (let count = 0; count < store.limits.receiptsKept; count++) {
        const requestId = randomUUID()
        insert.run(
          requestId,
          one.clientId,
          hash,
          JSON.stringify({ requestId, status: 'unknown' }),
          now,
          now + 1,
        )
      }
      db.exec('COMMIT')
      store.pruneReceipts(now + HOST_LIMITS.receiptTtlMs)
      expect(
        db.prepare('SELECT count(*) AS n FROM receipts WHERE finished_at IS NOT NULL').get()?.n,
      ).toBe(store.limits.receiptsKept)
      expect(store.beginRequest(unknown, one.clientId, hash, null).kind).toBe('new')
      store.pruneReceipts(now + HOST_LIMITS.receiptTtlMs + 2)
      expect(
        db.prepare('SELECT count(*) AS n FROM receipts WHERE finished_at IS NOT NULL').get()?.n,
      ).toBe(0)
      expect(store.beginRequest(started, one.clientId, hash, null)).toMatchObject({
        kind: 'existing',
        receipt: { status: 'pending' },
      })
    } finally {
      db.close()
    }
  })
})
