import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GitInfoCache } from './git-info-cache'
import type { GitInfo } from '@shared/models'

const info = (branch = 'main'): GitInfo => ({
  isRepo: true,
  branch,
  isWorktree: false,
  dirtyCount: 0,
})
function deferred() {
  let finish!: (value: GitInfo) => void
  const promise = new Promise<GitInfo>((done) => {
    finish = done
  })
  return { promise, finish }
}
afterEach(() => vi.useRealTimers())

describe('display Git cache', () => {
  it('deduplicates concurrent requests, with TTL starting at completion', async () => {
    vi.useFakeTimers()
    const cache = new GitInfoCache()
    const pending = deferred()
    const load = vi.fn(() => pending.promise)
    const reads = Array.from({ length: 20 }, () => cache.get('/repo', 'full', load))
    await vi.advanceTimersByTimeAsync(2000)
    expect(load).toHaveBeenCalledTimes(1)
    pending.finish(info())
    await Promise.all(reads)
    await vi.advanceTimersByTimeAsync(999)
    await cache.get('/repo', 'full', load)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await cache.get('/repo', 'full', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('waits for invalidated work, then coalesces one fresh query', async () => {
    const cache = new GitInfoCache()
    const old = deferred()
    const load = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(info('new'))
    const before = cache.get('/repo', 'full', load)
    cache.invalidate('/repo')
    const after = Array.from({ length: 20 }, () => cache.get('/repo', 'full', load))
    cache.invalidate('/repo')
    expect(load).toHaveBeenCalledTimes(1)
    old.finish(info('old'))
    expect((await before).branch).toBe('old')
    expect((await Promise.all(after)).every((value) => value.branch === 'new')).toBe(true)
    expect((await cache.get('/repo', 'full', load)).branch).toBe('new')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not cache failures or degraded results', async () => {
    const cache = new GitInfoCache()
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce({ isRepo: false })
      .mockResolvedValueOnce({ isRepo: true, branch: 'main' })
      .mockResolvedValue(info())
    await expect(cache.get('/repo', 'full', load)).rejects.toThrow('spawn failed')
    for (let i = 0; i < 4; i++) await cache.get('/repo', 'full', load)
    expect(load).toHaveBeenCalledTimes(4)
  })

  it('keeps query shapes separate and invalidates both', async () => {
    vi.useFakeTimers()
    const cache = new GitInfoCache()
    const full = vi.fn(async () => ({ ...info(), ahead: 3 }))
    const summary = vi.fn(async () => info())
    expect((await cache.get('/repo', 'full', full)).ahead).toBe(3)
    expect((await cache.get('/repo', 'summary', summary)).ahead).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1000)
    await cache.get('/repo', 'summary', summary)
    expect(summary).toHaveBeenCalledTimes(1)
    cache.invalidate('/repo')
    await cache.get('/repo', 'full', full)
    await cache.get('/repo', 'summary', summary)
    expect(full).toHaveBeenCalledTimes(2)
    expect(summary).toHaveBeenCalledTimes(2)
  })

  it('bounds concurrency across keys and query shapes, including failures', async () => {
    const cache = new GitInfoCache()
    const gates = Array.from({ length: 12 }, deferred)
    let active = 0
    let peak = 0
    const reads = gates.map((gate, i) =>
      cache
        .get(`/repo-${i}`, i % 2 ? 'full' : 'summary', async () => {
          active++
          peak = Math.max(peak, active)
          await gate.promise
          active--
          if (i === 0) throw new Error('failed')
          return info()
        })
        .catch(() => undefined),
    )
    expect(active).toBe(4)
    gates.forEach((gate) => gate.finish(info()))
    await Promise.all(reads)
    expect(peak).toBe(4)
    expect(active).toBe(0)
  })

  it('evicts least recently used results without dropping pending dedupe', async () => {
    const cache = new GitInfoCache(2)
    const load = vi.fn(async () => info())
    await cache.get('/a', 'full', load)
    await cache.get('/b', 'full', load)
    await cache.get('/a', 'full', load)
    await cache.get('/c', 'full', load)
    await cache.get('/b', 'full', load)
    expect(load).toHaveBeenCalledTimes(4)
    const pending = deferred()
    const slow = vi.fn(() => pending.promise)
    const first = cache.get('/slow', 'full', slow)
    for (let i = 0; i < 5; i++) await cache.get(`/other-${i}`, 'full', load)
    const second = cache.get('/slow', 'full', slow)
    pending.finish(info())
    await Promise.all([first, second])
    expect(slow).toHaveBeenCalledTimes(1)
    cache.invalidate()
    await cache.get('/slow', 'full', slow)
    expect(slow).toHaveBeenCalledTimes(2)
  })

  it('shares symlink aliases but not different worktrees', async () => {
    const root = mkdtempSync(join(tmpdir(), 'phosphor-git-cache-'))
    try {
      symlinkSync(root, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
      const cache = new GitInfoCache()
      const load = vi.fn(async () => info())
      await cache.get(root, 'full', load)
      await cache.get(join(root, 'alias'), 'full', load)
      expect(load).toHaveBeenCalledTimes(1)
      expect(load).toHaveBeenCalledWith(realpathSync.native(root))
      cache.invalidate(join(root, 'alias'))
      await cache.get(root, 'full', load)
      await cache.get(resolve(root, 'worktree'), 'full', load)
      expect(load).toHaveBeenCalledTimes(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
