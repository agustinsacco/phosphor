import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { openStore, opHash, HostStore } from './store'

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
  root = mkdtempSync(join(tmpdir(), 'host-store-'))
  directory = join(root, 'state')
  now = 1000
  store = await openStore(directory, uid, { now: () => now })
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
  store = await openStore(directory, uid, { now: () => now })
  handles.push(store)
}

describe('Host store ordering and durability', () => {
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
        expect(() => competitor.prepare('UPDATE lanes SET title=? WHERE lane_id=?').run('race', id)).toThrow(/locked/)
      }
      return prepare(sql)
    })
    try {
      expect(tested.admit(id, one, 1).admitted).toBe(true)
      expect(reads).toBeGreaterThan(0)
    } finally { spy.mockRestore(); tested.close(); competitor.close() }
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
  it('prunes at the 24-hour boundary and enforces the receipt count cap', async () => {
    const oldest = randomUUID()
    store.beginRequest(oldest, one.clientId, hash, null)
    store.finishRequest(oldest, { requestId: oldest, status: 'done' })
    store.pruneReceipts(now + HOST_LIMITS.receiptTtlMs - 1)
    expect(store.beginRequest(oldest, one.clientId, hash, null).kind).toBe('existing')
    store.pruneReceipts(now + HOST_LIMITS.receiptTtlMs)
    expect(store.beginRequest(oldest, one.clientId, hash, null).kind).toBe('new')
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    db.exec('BEGIN IMMEDIATE')
    for (let count = 1; count < HOST_LIMITS.receiptsKept - 1; count++)
      db.prepare("INSERT INTO receipts VALUES (?,?,?,NULL,'started',NULL,?,NULL)").run(
        randomUUID(),
        one.clientId,
        hash,
        now,
      )
    db.exec('COMMIT')
    db.close()
    expect(store.beginRequest(randomUUID(), one.clientId, hash, null).kind).toBe('new')
    expect(() => store.beginRequest(randomUUID(), one.clientId, hash, null)).toThrow()
    store.pruneReceipts(now + HOST_LIMITS.receiptTtlMs)
    expect(() => store.beginRequest(randomUUID(), one.clientId, hash, null)).toThrow()
  })
  it('enforces lane cap exactly, while existing lanes remain accessible and removed lanes free slots', () => {
    const first = lane()
    for (let count = 1; count < HOST_LIMITS.lanesPerHost; count++)
      lane(join(root, `${count}.jsonl`))
    expect(store.listLanes()).toHaveLength(HOST_LIMITS.lanesPerHost)
    expect(lane().laneId).toBe(first.laneId)
    expect(() => lane(join(root, 'over.jsonl'))).toThrow()
    store.markRemoved(first.laneId)
    lane(join(root, 'over.jsonl'))
    expect(() => lane()).toThrow()
  })
  it('syncs realpaths, keeps inactive records and enforces the configured repository cap', () => {
    const paths = Array.from({ length: HOST_LIMITS.repositoriesPerHost }, (_, i) =>
      join(root, `repo-${i}`),
    )
    for (const path of paths) mkdirSync(path)
    const summaries = store.syncRepositories(paths)
    expect(summaries).toHaveLength(HOST_LIMITS.repositoriesPerHost)
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
