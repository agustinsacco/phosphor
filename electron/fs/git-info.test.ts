import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as runner from './git-exec'
import { gitInfoCache } from './git-info-cache'
import { gitDisplayInfo, gitInfo, gitInfoBatch } from './git-info'

let root: string
let repo: string
beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'phosphor-git-info-')))
  repo = join(root, 'repo')
  await mkdir(repo)
  await runner.git(repo, ['init', '-b', 'main'])
  await runner.git(repo, ['config', 'user.email', 'test@phosphor.dev'])
  await runner.git(repo, ['config', 'user.name', 'Phosphor test'])
  await writeFile(join(repo, 'file'), 'initial')
  await runner.git(repo, ['add', '-A'])
  await runner.git(repo, ['commit', '-m', 'initial'])
  vi.spyOn(Date, 'now').mockReturnValue(1000) // TTL cannot expire on a slow CI machine.
})
afterEach(async () => {
  vi.restoreAllMocks()
  gitInfoCache.invalidate()
  await rm(root, { recursive: true, force: true })
})

describe('Git display cache integration', () => {
  it('shares one full loader across 20 callers, without caching safety checks', async () => {
    const spy = vi.spyOn(runner, 'git')
    const results = await Promise.all(Array.from({ length: 20 }, () => gitDisplayInfo(repo)))
    expect(results.every((info) => info.branch === 'main' && info.dirtyCount === 0)).toBe(true)
    const headerCalls = () =>
      spy.mock.calls.filter(([, args]) => args.join(' ') === 'rev-parse --abbrev-ref HEAD')
    expect(headerCalls()).toHaveLength(1)
    await gitInfoBatch([repo])
    await writeFile(join(repo, 'file'), 'dirty')
    expect((await gitDisplayInfo(repo)).dirtyCount).toBe(0)
    expect((await gitInfo(repo)).dirtyCount).toBe(1)
    expect(headerCalls()).toHaveLength(2)
    expect((await gitDisplayInfo(repo, { force: true })).dirtyCount).toBe(1)
    expect((await gitInfoBatch([repo]))[repo]?.dirtyCount).toBe(1)
    expect(headerCalls()).toHaveLength(3)
  })

  it('invalidates full and summary entries after branch changes, including siblings', async () => {
    const lane = join(root, 'lane')
    await runner.git(repo, ['worktree', 'add', '-b', 'feature', lane])
    expect((await gitDisplayInfo(lane)).branch).toBe('feature')
    expect((await gitInfoBatch([lane, lane]))[lane]?.branch).toBe('feature')
    await runner.git(repo, ['branch', '-m', 'feature', 'renamed'])
    expect((await gitDisplayInfo(lane)).branch).toBe('renamed')
    expect((await gitInfoBatch([lane]))[lane]?.branch).toBe('renamed')
  })

  it('invalidates even when a mutation fails, but not for ordinary reads', async () => {
    const invalidate = vi.spyOn(gitInfoCache, 'invalidate')
    await gitDisplayInfo(repo)
    await gitInfoBatch([repo])
    expect(invalidate).not.toHaveBeenCalled()
    await expect(runner.git(repo, ['checkout', 'missing-branch'])).rejects.toThrow()
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('deduplicates overlapping sidebar batches and preserves original result keys', async () => {
    const spy = vi.spyOn(runner, 'git')
    const alias = `${repo}/.`
    const results = await Promise.all(
      Array.from({ length: 10 }, () => gitInfoBatch([repo, alias, ''])),
    )
    expect(results[0]?.[repo]?.branch).toBe('main')
    expect(results[0]?.[alias]?.branch).toBe('main')
    expect(Object.keys(results[0]!)).not.toContain('')
    expect(spy.mock.calls.filter(([, args]) => args[0] === 'rev-parse')).toHaveLength(1)
  })
})
