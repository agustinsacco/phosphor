import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ATTACHMENT_LIMITS as LIMIT } from '@phosphor/shared/host-protocol-attachments'
import { createAttachmentState, type AttachmentState, type Upload } from './state'
import {
  abort,
  close,
  directory,
  discard,
  laneDirectory,
  remove,
  startSweep,
  sweep,
} from './storage'

let state: AttachmentState
let now: number
let exists: boolean
const laneId = randomUUID()
const log = vi.fn()
function addUpload(id = 'a'.repeat(32)): Upload {
  const path = join(laneDirectory(state.temporary, laneId), id)
  writeFileSync(path, 'partial')
  const upload = {
    laneId,
    clientId: 'client',
    fence: 1,
    path,
    name: 'report.pdf',
    size: 7,
    received: 0,
    index: 0,
    started: now,
    hash: createHash('sha256'),
  }
  state.uploads.set(id, upload)
  return upload
}
beforeEach(() => {
  now = Date.now()
  exists = true
  log.mockClear()
  state = createAttachmentState({
    directory: realpathSync(mkdtempSync(join(tmpdir(), 'attachment-storage-'))),
    now: () => now,
    laneExists: () => exists,
    log,
  })
  directory(state.root)
  directory(state.temporary)
})
afterEach(() => {
  close(state)
  vi.useRealTimers()
  rmSync(state.ports.directory, { recursive: true, force: true })
})

it('creates private canonical directories and rejects unsafe permissions, lane names and symlinks', () => {
  const lane = laneDirectory(state.root, laneId)
  expect(lstatSync(lane).mode & 0o777).toBe(0o700)
  expect(() => laneDirectory(state.root, '../escape')).toThrow('bad-request')
  chmodSync(lane, 0o755)
  expect(() => directory(lane)).toThrow()
  rmSync(lane, { recursive: true })
  symlinkSync(state.temporary, lane)
  expect(() => directory(lane)).toThrow()
})
it('discards map entries but refuses cleanup through a swapped ancestor with a content-free event', () => {
  const id = 'a'.repeat(32)
  const upload = addUpload(id)
  const lane = join(state.temporary, laneId)
  const outside = join(state.ports.directory, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, id), 'keep')
  rmSync(lane, { recursive: true })
  symlinkSync(outside, lane)
  discard(state, id, upload)
  expect(state.uploads.size).toBe(0)
  expect(readFileSync(join(outside, id), 'utf8')).toBe('keep')
  expect(log).toHaveBeenCalledExactlyOnceWith('attachments.cleanup-refused')
})
it('aborts only the selected lane and removes lane links without traversing them', () => {
  addUpload()
  abort(state, randomUUID())
  expect(state.uploads.size).toBe(1)
  abort(state, laneId)
  expect(state.uploads.size).toBe(0)
  expect(readdirSync(join(state.temporary, laneId))).toEqual([])
  const outside = join(state.ports.directory, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'keep'), 'safe')
  symlinkSync(outside, join(state.root, laneId))
  remove(state, laneId)
  remove(state, '../outside')
  expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('safe')
  expect(readdirSync(state.root)).toEqual([])
})
it('runs startup and periodic sweeps, retries failed sweeps, and stops its timer on close', () => {
  vi.useFakeTimers()
  const upload = addUpload()
  const orphan = join(state.temporary, laneId, 'b'.repeat(32))
  writeFileSync(orphan, 'orphan')
  now += LIMIT.lifetimeMs
  utimesSync(orphan, now / 1000, now / 1000)
  startSweep(state)
  expect(state.uploads.size).toBe(0)
  expect(lstatSync(orphan).isFile()).toBe(true)
  now += LIMIT.lifetimeMs + 1000
  chmodSync(state.root, 0o755)
  expect(() => vi.advanceTimersByTime(60000)).not.toThrow()
  chmodSync(state.root, 0o700)
  vi.advanceTimersByTime(60000)
  expect(readdirSync(join(state.temporary, laneId))).toEqual([])
  expect(state.timer?.hasRef()).toBe(false)
  expect(upload.received).toBe(0)
  close(state)
  expect(vi.getTimerCount()).toBe(0)
})
it('sweeps removed lanes and ignores non-lane entries and symlink orphans', () => {
  addUpload()
  const outside = join(state.ports.directory, 'outside')
  writeFileSync(outside, 'keep')
  symlinkSync(outside, join(state.temporary, laneId, 'b'.repeat(32)))
  writeFileSync(join(state.root, 'not-a-lane'), 'keep')
  now += LIMIT.lifetimeMs
  sweep(state)
  expect(readdirSync(join(state.temporary, laneId))).toEqual(['b'.repeat(32)])
  exists = false
  sweep(state)
  expect(readdirSync(state.temporary)).toEqual([])
  expect(readFileSync(outside, 'utf8')).toBe('keep')
  expect(readFileSync(join(state.root, 'not-a-lane'), 'utf8')).toBe('keep')
})
