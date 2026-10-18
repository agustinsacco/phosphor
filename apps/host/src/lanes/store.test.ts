import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type Receipt } from '@phosphor/shared/host-protocol'
import { loadSqlite } from './sqlite'
import { hostStateDirectory, prepareStateDirectory, prepareStateFile } from './state-dir'
import { openStore, opHash, HostStore, REMOVED_LANE_TTL_MS } from './store'

// HA-02 inventory baseline: 85 existing cases passed before the receipt-suite split.
let root: string
let directory: string
let store: HostStore
let repositoryId: string
let now: number
let corruptLane: ReturnType<typeof vi.fn<(count: number) => void>>
const handles: HostStore[] = []
const uid = process.getuid?.()
const one = { clientId: randomUUID(), label: 'One' }
const two = { clientId: randomUUID(), label: 'Two' }
const hash = opHash({ type: 'lane.stop' })
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'host-store-'))
  directory = join(root, 'state')
  now = 1000
  corruptLane = vi.fn()
  store = await openStore(directory, uid, {
    now: () => now,
    logCorruptLane: corruptLane,
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
    logCorruptLane: corruptLane,
    limits: { receiptsKept: 5, lanesPerHost: 5, repositoriesPerHost: 5 },
  })
  handles.push(store)
}

describe('Host store ordering and durability', () => {
  it('inserts the creator at fence 1 and ignores the option on existing and revived lanes', () => {
    const input = {
      repositoryId,
      cwd: join(root, 'repository'),
      sessionFile: join(root, 'creator.jsonl'),
    }
    const created = store.ensureLane(input, { controller: one })
    expect(created.control).toEqual({ fence: 1, controller: { ...one, connected: false } })
    expect(store.ensureLane(input, { controller: two }).control).toEqual(created.control)
    store.markRemoved(created.laneId)
    expect(store.ensureLane(input, { controller: two }).control).toEqual(created.control)
    expect(store.ensureLane({ ...input, sessionFile: null }).control).toEqual({
      fence: 1,
      controller: null,
    })
    expect(() =>
      store.ensureLane(
        { ...input, sessionFile: null },
        { controller: { clientId: 'invalid', label: 'Invalid' } },
      ),
    ).toThrow()
    expect(() =>
      store.ensureLane(
        { ...input, sessionFile: null },
        { controller: { ...one, label: 'bad\nlabel' } },
      ),
    ).toThrow()
    expect(corruptLane).not.toHaveBeenCalled()
  })
  it('defaults to contract caps and accepts only positive integer limits no larger than them', async () => {
    const defaults = await openStore(join(root, 'defaults'), uid)
    handles.push(defaults)
    expect(defaults.limits).toEqual({
      receiptsKept: HOST_LIMITS.receiptsKept,
      lanesPerHost: HOST_LIMITS.lanesPerHost,
      repositoriesPerHost: HOST_LIMITS.repositoriesPerHost,
    })
    for (const key of ['receiptsKept', 'lanesPerHost', 'repositoriesPerHost'] as const) {
      for (const value of [0, -1, 1.5, NaN, HOST_LIMITS[key] + 1])
        await expect(
          openStore(join(root, `invalid-${key}-${value}`), uid, { limits: { [key]: value } }),
        ).rejects.toThrow()
    }
  })
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
  it('uses stable lane UUIDs across reopen, removal and reappearance', async () => {
    const original = lane()
    expect(original.laneId).toMatch(/^[0-9a-f-]{14}4[0-9a-f-]{21}$/)
    expect(lane().laneId).toBe(original.laneId)
    store.markRemoved(original.laneId)
    expect(store.listLanes()).toEqual([])
    expect(lane().laneId).toBe(original.laneId)
    await reopen()
    expect(lane().laneId).toBe(original.laneId)
    expect(store.getLane(randomUUID())).toBeNull()
  })
  it('serializes two handles admitting the same empty controller and preserves increasing fences', async () => {
    const id = lane().laneId
    const other = await openStore(directory, uid)
    handles.push(other)
    expect(store.admit(id, one, 1)).toMatchObject({ admitted: true, control: { fence: 2 } })
    expect(other.admit(id, two, 1)).toMatchObject({
      admitted: false,
      code: 'stale-fence',
      control: { fence: 2, controller: { clientId: one.clientId } },
    })
    expect(other.admit(id, two, 2)).toMatchObject({ admitted: false, code: 'not-controller' })
    expect(store.admit(id, one, 2)).toMatchObject({ admitted: true, control: { fence: 2 } })
    expect(store.releaseControl(id, two.clientId)).toMatchObject({
      released: false,
      control: { fence: 2 },
    })
    expect(other.takeControl(id, two).fence).toBe(3)
    expect(store.releaseControl(id, two.clientId)).toMatchObject({
      released: true,
      control: { fence: 4, controller: null },
    })
    expect(store.admit(id, one, 4)).toMatchObject({ admitted: true, control: { fence: 5 } })
    await reopen()
    expect(store.getLane(id)?.control).toEqual({
      fence: 5,
      controller: { ...one, connected: false },
    })
    expect(store.takeControl(id, two).fence).toBe(6)
  })
  it('takes the SQLite writer lock before reading admission state', async () => {
    const id = lane().laneId
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    const competitor = new DatabaseSync(join(directory, 'state.sqlite'))
    competitor.exec('PRAGMA busy_timeout=0')
    const tested = new HostStore(db, {})
    const prepare = db.prepare.bind(db)
    let reads = 0
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('SELECT * FROM lanes WHERE lane_id=')) {
        reads++
        expect(() =>
          competitor.prepare('UPDATE lanes SET title=? WHERE lane_id=?').run('race', id),
        ).toThrow(/locked/)
      }
      return prepare(sql)
    })
    try {
      expect(tested.admit(id, one, 1).admitted).toBe(true)
      expect(reads).toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
      tested.close()
      competitor.close()
    }
  })
  it('computes connected through a runtime port without persisting it', async () => {
    const id = lane().laneId
    let connected = true
    const other = await openStore(directory, uid, { isConnected: () => connected })
    handles.push(other)
    expect(other.takeControl(id, one).controller?.connected).toBe(true)
    connected = false
    expect(other.getLane(id)?.control.controller?.connected).toBe(false)
    expect(store.getLane(id)?.control.controller?.connected).toBe(false)
  })
  it('updates metadata and monotonic counters, clamps read, rolls back invalid writes', () => {
    const id = lane().laneId
    now++
    expect(
      store.updateLane(id, { title: 'Title', branch: 'topic', provider: 'test', model: 'model' }),
    ).toMatchObject({ title: 'Title', branch: 'topic', model: { provider: 'test', id: 'model' } })
    expect(store.bumpAttention(id)).toBe(1)
    expect(store.bumpAttention(id)).toBe(2)
    expect(store.markRead(id, 1)).toBe(1)
    expect(store.markRead(id, 0)).toBe(1)
    expect(store.markRead(id, 999)).toBe(2)
    expect(() => store.markRead(id, -1)).toThrow()
    expect(() => store.updateLane(id, { provider: null })).toThrow()
    expect(store.getLane(id)?.model).toEqual({ provider: 'test', id: 'model' })
    expect(() => store.updateLane(id, { title: 'x'.repeat(HOST_LIMITS.labelChars + 1) })).toThrow()
    expect(store.updateLane(id, { title: 'x'.repeat(HOST_LIMITS.labelChars) }).title).toHaveLength(
      HOST_LIMITS.labelChars,
    )
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
  it('enforces lane cap exactly, while existing lanes remain accessible and removed lanes free slots', () => {
    const first = lane()
    for (let count = 1; count < store.limits.lanesPerHost; count++)
      lane(join(root, `${count}.jsonl`))
    expect(store.listLanes()).toHaveLength(store.limits.lanesPerHost)
    expect(lane().laneId).toBe(first.laneId)
    expect(() => lane(join(root, 'over.jsonl'))).toThrow()
    store.markRemoved(first.laneId)
    lane(join(root, 'over.jsonl'))
    expect(() => lane()).toThrow()
  })
  it('prunes removed lanes by age without touching live lanes or recorded receipt identities', () => {
    const removed = lane()
    const live = lane(null)
    const finished = randomUUID()
    const started = randomUUID()
    store.beginRequest(finished, one.clientId, hash, removed.laneId)
    store.finishRequest(finished, { requestId: finished, status: 'done' })
    store.beginRequest(started, one.clientId, hash, removed.laneId)
    store.markRemoved(removed.laneId)
    store.pruneRemovedLanes(now + REMOVED_LANE_TTL_MS)
    expect(store.getLane(removed.laneId)).not.toBeNull()
    store.pruneRemovedLanes(now + REMOVED_LANE_TTL_MS + 1)
    expect(store.getLane(removed.laneId)).toBeNull()
    expect(store.getLane(live.laneId)?.removedAt).toBeNull()
    for (const requestId of [finished, started]) {
      expect(store.beginRequest(requestId, one.clientId, hash, removed.laneId)).toMatchObject({
        kind: 'existing',
      })
      expect(store.beginRequest(requestId, one.clientId, hash, live.laneId)).toEqual({
        kind: 'conflict',
      })
    }
    expect(lane().laneId).not.toBe(removed.laneId)
  })
  it('keeps exactly the removed lane cap, deleting the oldest while preserving live lanes', async () => {
    const oldest = lane()
    store.markRemoved(oldest.laneId)
    const live = lane(null)
    for (let count = 0; count < store.limits.lanesPerHost; count++) {
      now++
      store.markRemoved(lane(join(root, `${count}.jsonl`)).laneId)
    }
    store.pruneRemovedLanes()
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    try {
      expect(
        db.prepare('SELECT count(*) AS n FROM lanes WHERE removed_at IS NOT NULL').get()?.n,
      ).toBe(store.limits.lanesPerHost)
      expect(store.getLane(oldest.laneId)).toBeNull()
      expect(store.listLanes().map((entry) => entry.laneId)).toEqual([live.laneId])
    } finally {
      db.close()
    }
  })
  it('skips unavailable configured repositories, deactivates their rows and reactivates stable ids', () => {
    const missing = join(root, 'returning')
    const present = join(root, 'repository')
    mkdirSync(missing)
    const original = store
      .syncRepositories([missing, present])
      .find((entry) => entry.path.endsWith('/returning'))
    rmSync(missing, { recursive: true })
    const unavailable: number[] = []
    expect(store.syncRepositories([missing, present], (count) => unavailable.push(count))).toEqual([
      expect.objectContaining({ id: repositoryId }),
    ])
    expect(unavailable).toEqual([1])
    mkdirSync(missing)
    expect(store.syncRepositories([missing, present])).toContainEqual(original)
    const file = join(root, 'not-folder')
    writeFileSync(file, '')
    expect(
      store.syncRepositories([file, join(file, 'child')], (count) => unavailable.push(count)),
    ).toEqual([])
    expect(unavailable).toEqual([1, 2])
  })
  it('skips EACCES but propagates other repository I/O failures', () => {
    const spy = vi.spyOn(realpathSync, 'native')
    try {
      spy.mockImplementationOnce(() => {
        throw Object.assign(new Error('private failure'), { code: 'EACCES' })
      })
      const unavailable: number[] = []
      expect(
        store.syncRepositories([join(root, 'repository')], (count) => unavailable.push(count)),
      ).toEqual([])
      expect(unavailable).toEqual([1])
      spy.mockImplementationOnce(() => {
        throw Object.assign(new Error('I/O failure'), { code: 'EIO' })
      })
      expect(() => store.syncRepositories([join(root, 'repository')])).toThrow('I/O failure')
    } finally {
      spy.mockRestore()
    }
  })
  it('syncs realpaths, keeps inactive records and enforces the configured repository cap', () => {
    const paths = Array.from({ length: store.limits.repositoriesPerHost }, (_, i) =>
      join(root, `repo-${i}`),
    )
    for (const path of paths) mkdirSync(path)
    const summaries = store.syncRepositories(paths)
    expect(summaries).toHaveLength(store.limits.repositoriesPerHost)
    expect(() => store.syncRepositories([...paths, join(root, 'repository')])).toThrow()
    expect(store.listRepositories()).toEqual(summaries)
    store.syncRepositories([])
    expect(store.listRepositories()).toEqual([])
    expect(store.syncRepositories(paths)).toEqual(summaries)
    const link = join(root, 'repo-link')
    symlinkSync(paths[0] ?? '', link)
    expect(store.syncRepositories([link])[0]).toEqual(
      summaries.find((entry) => entry.name === 'repo-0'),
    )
  })
})

describe('Host state storage safety', () => {
  it.each([0, 0o077, 0o777])('sets exact modes under umask %i', async (mask) => {
    const previous = process.umask(mask)
    let handle: HostStore | undefined
    const dir = join(root, `mode-${mask}`)
    try {
      handle = await openStore(dir, uid)
      for (const suffix of ['-wal', '-shm'])
        expect(lstatSync(join(dir, `state.sqlite${suffix}`)).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(previous)
      handle?.close()
    }
    expect(lstatSync(dir).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(dir, 'state.sqlite')).mode & 0o777).toBe(0o600)
  })
  it('uses one XDG rule and ignores relative overrides', () => {
    expect(hostStateDirectory({ XDG_STATE_HOME: '/state' }, '/home')).toBe('/state/phosphor-host')
    expect(hostStateDirectory({ XDG_STATE_HOME: 'relative' }, '/home')).toBe(
      '/home/.local/state/phosphor-host',
    )
  })
  it('refuses symlinked, foreign-owned, permissive and non-directory storage', async () => {
    const linked = join(root, 'linked')
    symlinkSync(directory, linked)
    await expect(openStore(linked, uid)).rejects.toMatchObject({ exitCode: 78 })
    expect(() => prepareStateDirectory(directory, uid === undefined ? 1 : uid + 1)).toThrow()
    expect(() => prepareStateFile(directory, uid === undefined ? 1 : uid + 1)).toThrow()
    expect(() => prepareStateDirectory(directory, undefined)).toThrow()
    chmodSync(directory, 0o777)
    await expect(openStore(directory, uid)).rejects.toMatchObject({ exitCode: 78 })
    chmodSync(directory, 0o700)
    const file = join(root, 'not-directory')
    writeFileSync(file, '')
    await expect(openStore(file, uid)).rejects.toMatchObject({ exitCode: 78 })
  })
  it('refuses permissive and non-regular state files', async () => {
    chmodSync(join(directory, 'state.sqlite'), 0o644)
    await expect(openStore(directory, uid)).rejects.toMatchObject({ exitCode: 78 })
    chmodSync(join(directory, 'state.sqlite'), 0o600)
    const dir = join(root, 'directory-file')
    mkdirSync(join(dir, 'state.sqlite'), { recursive: true, mode: 0o700 })
    await expect(openStore(dir, uid)).rejects.toMatchObject({ exitCode: 78 })
  })
  it('refuses symlinked state and sidecars without changing targets', async () => {
    const target = join(root, 'target')
    writeFileSync(target, 'unchanged')
    for (const suffix of ['', '-wal', '-shm']) {
      const dir = join(root, `linked-${suffix}`)
      mkdirSync(dir, { mode: 0o700 })
      symlinkSync(target, join(dir, `state.sqlite${suffix}`))
      await expect(openStore(dir, uid)).rejects.toMatchObject({ exitCode: 78 })
      expect(readFileSync(target, 'utf8')).toBe('unchanged')
    }
  })
  it('refuses a newer user_version and closes its handle on failure', async () => {
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    db.exec('PRAGMA user_version=2')
    db.close()
    await expect(openStore(directory, uid)).rejects.toMatchObject({
      exitCode: 78,
      message: expect.stringContaining('this state was written by a newer Host'),
    })
    const again = new DatabaseSync(join(directory, 'state.sqlite'))
    again.exec('PRAGMA user_version=1')
    again.close()
    await reopen()
  })
  it('holds database invariants even when SQL bypasses the API', async () => {
    const id = lane().laneId
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    try {
      for (const sql of [
        'fence=0',
        'attention=-1',
        'read=1',
        "controller_client_id=NULL,controller_label='bad'",
        "provider='test',model=NULL",
      ])
        expect(() => db.prepare(`UPDATE lanes SET ${sql} WHERE lane_id=?`).run(id)).toThrow()
    } finally {
      db.close()
    }
  })
  it('hashes nested JSON canonically and rejects non-JSON, deep and oversize values', () => {
    expect(
      opHash({ type: 'lane.create', repositoryId, worktree: { branch: 'topic' }, name: 'name' }),
    ).toBe(
      opHash({ name: 'name', worktree: { branch: 'topic' }, repositoryId, type: 'lane.create' }),
    )
    expect(opHash({ type: 'lane.stop' })).not.toBe(opHash({ type: 'lane.resume' }))
  })
})

describe('corrupt summary rows', () => {
  it.each([
    ['lane_id', 'invalid'],
    ['lane_id', '00000000-0000-1000-8000-000000000000'],
    ['repository_id', 'x'.repeat(16)],
    ['repository_id', 'a'.repeat(15)],
    ['cwd', 'relative'],
    ['cwd', '/not/../normalized'],
    ['session_file', 'relative'],
    ['title', 'private\ntext'],
    ['title', 'x'.repeat(81)],
    ['branch', ''],
    ['branch', 'x'.repeat(257)],
    ['branch', 'private\ttext'],
    ['worktree', 2],
    ['provider', ''],
    ['provider', 'x'.repeat(65)],
    ['provider', 'private\ntext'],
    ['provider', 'unpaired'],
    ['model', ''],
    ['model', 'x'.repeat(129)],
    ['model', 'private\ntext'],
    ['model', 'unpaired'],
    ['created_at', -1],
    ['created_at', 8640000000000001],
    ['updated_at', 999],
    ['updated_at', 8640000000000001],
    ['fence', 0],
    ['fence', 9007199254740992],
    ['fence', 1.5],
    ['controller_client_id', 'invalid'],
    ['controller_client_id', null],
    ['controller_label', null],
    ['controller_label', 'private\ntext'],
    ['controller_label', ''],
    ['controller_label', 'x'.repeat(81)],
    ['attention', -1],
    ['attention', 9007199254740992],
    ['attention', 1.5],
    ['read', -1],
    ['read', 1],
    ['removed_at', -1],
    ['removed_at', 8640000000000001],
  ])('skips corrupt lane %s without throwing, repairing or leaking it', async (field, value) => {
    const original = lane()
    store.takeControl(original.laneId, one)
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    const log = vi.fn((_count: number) => {
      throw new Error('logger failed')
    })
    const tested = new HostStore(db, { logCorruptLane: log })
    try {
      db.exec('PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF')
      if (typeof value === 'number' && !Number.isInteger(value)) {
        expect(() =>
          db.prepare(`UPDATE lanes SET ${field}=? WHERE lane_id=?`).run(value, original.laneId),
        ).toThrow(/cannot store REAL/)
        expect(tested.getLane(original.laneId)).not.toBeNull()
        return
      }
      db.prepare(`UPDATE lanes SET ${field}=? WHERE lane_id=?`).run(value, original.laneId)
      expect(tested.listLanes()).toEqual([])
      const id = field === 'lane_id' && value !== 'invalid' ? String(value) : original.laneId
      expect(tested.getLane(id)).toBeNull()
      if (original.sessionFile === null) throw new Error('missing file')
      expect(tested.sessionLane(original.sessionFile)).toBeNull()
      const query = db.prepare(`SELECT ${field} AS value FROM lanes`)
      query.setReadBigInts(true)
      expect(query.get()?.value).toBe(typeof value === 'number' ? BigInt(value) : value)
      expect(log).toHaveBeenCalledWith(1)
      expect(log.mock.calls.every((args) => args.length === 1 && args[0] === 1)).toBe(true)
    } finally {
      tested.close()
    }
  })
  it.each([
    ['id', 'invalid'],
    ['path', 'relative'],
    ['path', '/not/../normalized'],
    ['name', ''],
    ['name', 'private\ntext'],
    ['name', 'x'.repeat(4097)],
    ['added_at', -1],
    ['added_at', 9007199254740992],
    ['added_at', 8640000000000001],
  ])('skips corrupt repository %s without throwing or repairing it', async (field, value) => {
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    const log = vi.fn()
    const tested = new HostStore(db, { logCorruptLane: log })
    try {
      db.exec('PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF')
      db.prepare(`UPDATE repositories SET ${field}=?`).run(value)
      expect(tested.listRepositories()).toEqual([])
      const query = db.prepare(`SELECT ${field} AS value FROM repositories`)
      query.setReadBigInts(true)
      expect(query.get()?.value).toBe(typeof value === 'number' ? BigInt(value) : value)
      expect(log.mock.calls).toEqual([[1]])
    } finally {
      tested.close()
    }
  })
  it('migration 1 checks absolute paths and repository id length and indexes active ordering', async () => {
    const original = lane()
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    try {
      for (const field of ['cwd', 'session_file']) {
        expect(() => db.prepare(`UPDATE lanes SET ${field}=?`).run('relative')).toThrow(/CHECK/)
      }
      expect(() => db.prepare('UPDATE repositories SET path=?').run('relative')).toThrow(/CHECK/)
      expect(() => db.prepare('UPDATE lanes SET repository_id=?').run('short')).toThrow(/CHECK/)
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
      expect(
        db.prepare("SELECT sql FROM sqlite_master WHERE name='repositories_active'").get()?.sql,
      ).toMatch(/ON repositories\(added_at,id\) WHERE active=1/)
      expect(store.getLane(original.laneId)).not.toBeNull()
    } finally {
      db.close()
    }
  })
})
