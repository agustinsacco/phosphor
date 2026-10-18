import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type LaneSummary } from '@phosphor/shared/host-protocol'
import type { AgentMessage } from '@phosphor/shared/rpc'
import { createUnattachedSnapshots } from './transcript'
import { fitSnapshot, type SnapshotResult } from './projection-host'
import type { StoredLane } from './store'

vi.mock('node:fs', { spy: true })

const summary: LaneSummary = {
  laneId: 'lane',
  repositoryId: 'repository',
  cwd: '/repo',
  title: null,
  branch: null,
  worktree: false,
  model: null,
  activity: 'idle',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  attention: 0,
  read: 0,
  control: { fence: 1, controller: null },
}
const cursor = { epoch: 'epoch', seq: 0 }
const fileBytes = 64 * 1024 * 1024
const header = JSON.stringify({ type: 'session', version: 3, id: 'fixture' })
function transcript(messages: AgentMessage[]) {
  return [
    header,
    ...messages.map((message, index) =>
      JSON.stringify({
        type: 'message',
        id: String(index),
        parentId: index ? String(index - 1) : null,
        message,
      }),
    ),
  ].join('\n')
}
function snapshot(result: SnapshotResult | null) {
  expect(result?.ok).toBe(true)
  if (!result?.ok) throw new Error('expected snapshot')
  return result.snapshot
}
let directory: string
let root: string
let lanes: Map<string, StoredLane>
let log: ReturnType<typeof vi.fn<() => void>>
let read: ReturnType<typeof createUnattachedSnapshots>
let getSummary: ReturnType<typeof vi.fn<(id: string) => LaneSummary | null>>
function lane(id: string, sessionFile: string | null) {
  lanes.set(id, { ...summary, laneId: id, sessionFile, removedAt: null })
}
function file(id = 'lane', messages: AgentMessage[] = [{ role: 'user', content: 'hello' }]) {
  const path = join(root, `${id}.jsonl`)
  fs.writeFileSync(path, transcript(messages))
  lane(id, path)
  return path
}
function logged(reason: string) {
  expect(log.mock.calls).toEqual([['lane.transcript_unreadable', { laneId: 'lane', reason }]])
}
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'phosphor-transcript-')))
  root = join(directory, 'sessions')
  fs.mkdirSync(root)
  lanes = new Map()
  log = vi.fn()
  getSummary = vi.fn((id: string): LaneSummary | null => lanes.get(id) ?? null)
  read = createUnattachedSnapshots({
    store: { getLane: (id) => lanes.get(id) ?? null },
    summary: getSummary,
    cursor: () => cursor,
    sessionsRoot: root,
    log,
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('stopped transcript contract', () => {
  it('returns an empty transcript for a null or absent file, without logging', () => {
    lane('lane', null)
    expect(snapshot(read('lane')).messages).toEqual([])
    lane('lane', join(root, 'missing'))
    expect(snapshot(read('lane')).messages).toEqual([])
    expect(log).not.toHaveBeenCalled()
  })
  it('returns null for unknown, removed, or missing-summary lanes', () => {
    getSummary.mockReturnValue(summary)
    expect(read('unknown')).toBeNull()
    getSummary.mockImplementation((id) => lanes.get(id) ?? null)
    file()
    lanes.set('lane', {
      ...summary,
      sessionFile: join(root, 'lane.jsonl'),
      removedAt: '2026-01-01T00:00:00Z',
    })
    expect(read('lane')).toBeNull()
    lane('lane', null)
    getSummary.mockReturnValue(null)
    expect(read('lane')).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })
  it('refuses symlinked files without logging their path', () => {
    const target = file('target')
    const path = join(root, 'link')
    fs.symlinkSync(target, path)
    lane('lane', path)
    expect(read('lane')).toBeNull()
    logged('open')
  })
  it('rejects files outside the root, including sibling prefix paths', () => {
    const sibling = `${root}-other`
    fs.mkdirSync(sibling)
    const path = join(sibling, 'private')
    fs.writeFileSync(path, transcript([{ role: 'user', content: 'private' }]))
    lane('lane', path)
    expect(read('lane')).toBeNull()
    logged('outside')
  })
  it('accepts exactly 64 MiB and rejects one byte past it before reading', () => {
    const path = file()
    const buffer = Buffer.alloc(fileBytes, ' ')
    buffer.write(header)
    fs.writeFileSync(path, buffer)
    expect(snapshot(read('lane')).messages).toEqual([])
    const spy = vi.spyOn(fs, 'readSync').mockClear()
    fs.appendFileSync(path, ' ')
    expect(read('lane')).toEqual({ ok: false, reason: 'too-large' })
    expect(spy).not.toHaveBeenCalled()
    logged('limit')
  })
  it('bounds reads if the file grows after fstat', async () => {
    file()
    const original = (await vi.importActual<typeof fs>('node:fs')).fstatSync
    vi.spyOn(fs, 'fstatSync').mockImplementation((fd) => {
      const stat = original(fd)
      stat.size--
      return stat
    })
    expect(read('lane')).toEqual({ ok: false, reason: 'too-large' })
    logged('limit')
  })
  it('reads the checked fd, closes it, and caches only four recently used lanes', () => {
    for (let i = 0; i < 5; i++) file(String(i))
    const readSpy = vi.spyOn(fs, 'readSync').mockClear()
    const openSpy = vi.spyOn(fs, 'openSync').mockClear()
    const closeSpy = vi.spyOn(fs, 'closeSync').mockClear()
    read('0')
    expect(readSpy.mock.calls[0]?.[0]).toBe(openSpy.mock.results[0]?.value)
    expect(closeSpy).toHaveBeenCalledWith(openSpy.mock.results[0]?.value)
    const calls = readSpy.mock.calls.length
    read('0')
    expect(readSpy).toHaveBeenCalledTimes(calls)
    for (let i = 1; i < 5; i++) read(String(i))
    readSpy.mockClear()
    read('1')
    expect(readSpy).not.toHaveBeenCalled()
    read('0')
    expect(readSpy).toHaveBeenCalled()
  })
  it('evicts the least recently used lane, not the least recently inserted', () => {
    for (let i = 0; i < 5; i++) file(String(i))
    const readSpy = vi.spyOn(fs, 'readSync')
    read('0')
    read('1')
    read('0')
    for (let i = 2; i < 5; i++) read(String(i))
    readSpy.mockClear()
    read('0')
    expect(readSpy).not.toHaveBeenCalled()
    read('1')
    expect(readSpy).toHaveBeenCalled()
  })
  it('rejects an inode swapped between open and realpath', async () => {
    const path = file()
    const replacement = file('replacement')
    const original = (await vi.importActual<typeof fs>('node:fs')).realpathSync
    vi.spyOn(fs, 'realpathSync').mockImplementation((name) => {
      if (name === path && fs.existsSync(replacement)) fs.renameSync(replacement, path)
      return original(name)
    })
    expect(read('lane')).toBeNull()
    logged('open')
  })
  it('uses the shared snapshot size rule and elides images oldest first', () => {
    const images: AgentMessage[] = ['a', 'b'].map((data) => ({
      role: 'user',
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          data: data.repeat(HOST_LIMITS.outboundFrameBytes * 0.6),
        },
      ],
    }))
    file('lane', images)
    const actual = snapshot(read('lane'))
    expect(read('lane')).toEqual(fitSnapshot({ ...actual, messages: images }))
    expect(actual.messages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `[image omitted: ${Math.ceil(Math.floor(HOST_LIMITS.outboundFrameBytes * 0.6) / 1024)} KB]`,
        },
      ],
    })
    expect(actual.messages[1]).toEqual(images[1])
    file('large', [{ role: 'user', content: 'x'.repeat(HOST_LIMITS.outboundFrameBytes) }])
    expect(read('large')).toEqual({ ok: false, reason: 'too-large' })
    expect(log).not.toHaveBeenCalled()
  })
})
