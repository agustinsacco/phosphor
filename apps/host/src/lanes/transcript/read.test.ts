import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptCache } from './cache'
import { readTranscript, type TranscriptFailureReason } from './read'

vi.mock('node:fs', { spy: true })

const header = JSON.stringify({ type: 'session', version: 3, id: 'fixture' })
const messages = [{ role: 'user' as const, content: 'hello' }]
const content = `${header}\n${JSON.stringify({
  type: 'message',
  id: 'message',
  parentId: null,
  message: messages[0],
})}`
let directory: string
let root: string
let path: string
let cache: ReturnType<typeof createTranscriptCache>
const onFailure = vi.fn<(reason: TranscriptFailureReason) => void>()

function read() {
  return readTranscript({ sessionFile: path, sessionsRoot: root, laneId: 'lane', cache, onFailure })
}
function closed() {
  const fd = vi.mocked(fs.openSync).mock.results[0]?.value
  expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(fd)
}

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'phosphor-transcript-read-')))
  root = join(directory, 'sessions')
  fs.mkdirSync(root)
  path = join(root, 'lane.jsonl')
  fs.writeFileSync(path, content)
  cache = createTranscriptCache()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('bounded transcript reader', () => {
  it('opens read-only, no-follow, non-blocking and reads and closes the checked fd', () => {
    expect(read()).toEqual({ kind: 'messages', messages })
    expect(fs.openSync).toHaveBeenCalledExactlyOnceWith(
      path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    )
    const fd = vi.mocked(fs.openSync).mock.results[0]?.value
    expect(fs.fstatSync).toHaveBeenCalledExactlyOnceWith(fd)
    expect(vi.mocked(fs.readSync).mock.calls.every((call) => call[0] === fd)).toBe(true)
    closed()
  })

  it.each([
    ['ENOENT', 'missing'],
    ['EACCES', 'unreadable'],
    ['ELOOP', 'unreadable'],
  ])('classifies open %s without attempting a close', (code, kind) => {
    vi.mocked(fs.openSync).mockImplementation(() => {
      throw Object.assign(new Error('open failed'), { code })
    })
    expect(read()).toEqual(kind === 'missing' ? { kind } : { kind, reason: 'open' })
    expect(fs.closeSync).not.toHaveBeenCalled()
    expect(fs.readSync).not.toHaveBeenCalled()
    if (kind === 'missing') expect(onFailure).not.toHaveBeenCalled()
    else expect(onFailure).toHaveBeenCalledExactlyOnceWith('open')
  })

  it('keeps non-Error ENOENT values unreadable', () => {
    vi.mocked(fs.openSync).mockImplementation(() => {
      throw { code: 'ENOENT' }
    })
    expect(read()).toEqual({ kind: 'unreadable', reason: 'open' })
    expect(fs.closeSync).not.toHaveBeenCalled()
  })

  it.each(['fstatSync', 'realpathSync', 'statSync', 'readSync'] as const)(
    'closes the fd when %s fails',
    (operation) => {
      vi.mocked(fs[operation]).mockImplementation(() => {
        throw new Error('inaccessible')
      })
      expect(read()).toEqual({ kind: 'unreadable', reason: 'open' })
      closed()
    },
  )

  it('closes the fd when canonicalizing the sessions root fails', async () => {
    const original = (await vi.importActual<typeof fs>('node:fs')).realpathSync
    vi.mocked(fs.realpathSync).mockImplementation((name) => {
      if (name === root) throw new Error('inaccessible root')
      return original(name)
    })
    expect(read()).toEqual({ kind: 'unreadable', reason: 'open' })
    closed()
  })

  it('rejects non-regular files before resolving or reading them', () => {
    path = root
    vi.mocked(fs.realpathSync).mockClear()
    expect(read()).toEqual({ kind: 'unreadable', reason: 'type' })
    expect(fs.realpathSync).not.toHaveBeenCalled()
    expect(fs.readSync).not.toHaveBeenCalled()
    closed()
  })

  it.each(['parent', 'sibling', 'symlink'])('rejects canonical %s escapes', (escape) => {
    const outside = escape === 'sibling' ? `${root}-other` : directory
    if (escape === 'sibling') fs.mkdirSync(outside)
    const target = join(outside, 'private.jsonl')
    fs.writeFileSync(target, content)
    if (escape === 'symlink') {
      fs.symlinkSync(directory, join(root, 'link'))
      path = join(root, 'link', 'private.jsonl')
    } else path = target
    expect(read()).toEqual({ kind: 'unreadable', reason: 'outside' })
    expect(fs.readSync).not.toHaveBeenCalled()
    closed()
  })

  it('accepts a canonical root reached through a symlink', () => {
    const alias = join(directory, 'alias')
    fs.symlinkSync(root, alias)
    root = alias
    expect(read()).toEqual({ kind: 'messages', messages })
    closed()
  })

  it.each(['dev', 'ino'] as const)(
    'rejects a different canonical %s before reading',
    async (key) => {
      const original = (await vi.importActual<typeof fs>('node:fs')).statSync
      vi.mocked(fs.statSync).mockImplementation((name) => {
        const stat = original(name)
        stat[key]++
        return stat
      })
      expect(read()).toEqual({ kind: 'unreadable', reason: 'open' })
      expect(fs.readSync).not.toHaveBeenCalled()
      closed()
    },
  )

  it('rejects more than 64 MiB before allocating or reading', async () => {
    const original = (await vi.importActual<typeof fs>('node:fs')).fstatSync
    vi.mocked(fs.fstatSync).mockImplementation((fd) => {
      const stat = original(fd)
      stat.size = 64 * 1024 * 1024 + 1
      return stat
    })
    expect(read()).toEqual({ kind: 'too-large' })
    expect(fs.readSync).not.toHaveBeenCalled()
    closed()
  })

  it('reads at most fstat size plus one byte if a file grows', async () => {
    const original = (await vi.importActual<typeof fs>('node:fs')).fstatSync
    vi.mocked(fs.fstatSync).mockImplementation((fd) => {
      const stat = original(fd)
      stat.size = 3
      return stat
    })
    expect(read()).toEqual({ kind: 'too-large' })
    const call = vi.mocked(fs.readSync).mock.calls[0]
    expect(call?.[1].byteLength).toBe(4)
    expect(fs.readSync).toHaveBeenCalledTimes(1)
    closed()
  })

  it('handles partial reads and an early EOF after shrink', async () => {
    const original = (await vi.importActual<typeof fs>('node:fs')).readSync
    vi.mocked(fs.readSync).mockImplementation(
      (
        fd,
        buffer,
        offset: number | fs.ReadOptions = 0,
        length = buffer.byteLength,
        position: fs.ReadPosition | null = null,
      ) => {
        if (typeof offset !== 'number') throw new Error('expected positional read')
        const remaining = Buffer.byteLength(content) - offset
        return remaining > 0
          ? original(fd, buffer, offset, Math.min(length, 7, remaining), position)
          : 0
      },
    )
    fs.writeFileSync(path, `${content}    `)
    expect(read()).toEqual({ kind: 'messages', messages })
    expect(vi.mocked(fs.readSync).mock.calls.length).toBeGreaterThan(2)
    closed()
  })

  it.each([
    'invalid header',
    `${header}\n${JSON.stringify({
      type: 'message',
      id: 'cycle',
      parentId: 'cycle',
      message: messages[0],
    })}`,
  ])('closes the fd on a parse failure (%#)', (invalid) => {
    fs.writeFileSync(path, invalid)
    expect(read()).toEqual({ kind: 'unreadable', reason: 'parse' })
    closed()
  })

  it('validates even a cache hit, skips its read, and refreshes recency', () => {
    expect(read()).toEqual({ kind: 'messages', messages })
    for (let i = 0; i < 3; i++) cache.set(String(i), 'stamp', [])
    vi.mocked(fs.readSync).mockClear()
    vi.mocked(fs.closeSync).mockClear()
    expect(read()).toEqual({ kind: 'messages', messages })
    expect(fs.readSync).not.toHaveBeenCalled()
    expect(fs.fstatSync).toHaveBeenCalledTimes(2)
    closed()
    cache.set('fourth', 'stamp', [])
    expect(read()).toEqual({ kind: 'messages', messages })
    expect(fs.readSync).not.toHaveBeenCalled()
  })

  it.each(['dev', 'ino', 'size', 'mtimeMs'] as const)(
    'invalidates a cached %s stamp',
    async (key) => {
      read()
      const actual = await vi.importActual<typeof fs>('node:fs')
      vi.mocked(fs.fstatSync).mockImplementation((fd) => {
        const stat = actual.fstatSync(fd)
        stat[key]++
        return stat
      })
      vi.mocked(fs.statSync).mockImplementation((name) => {
        const stat = actual.statSync(name)
        stat[key]++
        return stat
      })
      vi.mocked(fs.readSync).mockClear()
      expect(read()).toEqual({ kind: 'messages', messages })
      expect(fs.readSync).toHaveBeenCalled()
    },
  )

  it('propagates close failures without retrying the close', async () => {
    const original = (await vi.importActual<typeof fs>('node:fs')).closeSync
    vi.mocked(fs.closeSync).mockImplementation((fd) => {
      original(fd)
      throw new Error('close failed')
    })
    expect(read).toThrow('close failed')
    closed()
  })
})
