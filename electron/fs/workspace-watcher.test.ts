import { describe, expect, it, vi } from 'vitest'
import type { Stats } from 'node:fs'
import {
  IGNORED_DIR_PATTERN,
  MAX_DIR_ENTRIES,
  MAX_WATCH_DEPTH,
  MAX_WATCHED_PATHS,
  WatchBudget,
  createWatchFilter,
} from './workspace-watcher'

const dirStats = { isDirectory: () => true } as Stats
const fileStats = { isDirectory: () => false } as Stats

/**
 * Guards two separate EMFILE incidents, which failed on different axes.
 *
 * The first was directory count: an unbounded walk of augment-services (2.7M
 * entries) reached 47,060 directories. The prune list and the depth cap fixed
 * that.
 *
 * The second was FILE count, which neither of those bounds touches. chokidar
 * opens one fd per watched PATH, files included, and the depth cap is blind
 * to a flat directory — every file in it sits at the same legal depth. On
 * augment-local, `.overrides-local/workflow-retries/captures` held 133,518
 * `MAX_DIR_ENTRIES` and the process-wide `MAX_WATCHED_PATHS` are what bound
 * that. The latter stays below macOS libuv's fd 10,239 spawn limit: above it
 * `child_process.spawn` reports EBADF and blocks a new pi session.
 */
describe('workspace watcher bounds', () => {
  it('prunes the heavy directories that made the walk unbounded', () => {
    for (const dir of ['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.venv']) {
      expect(IGNORED_DIR_PATTERN.test(`/repo/${dir}`)).toBe(true)
      expect(IGNORED_DIR_PATTERN.test(`/repo/${dir}/nested/deep.ts`)).toBe(true)
    }
  })

  it('prunes nested occurrences, not just top-level ones', () => {
    // The monorepo's cost was 767 nested node_modules, not the root one.
    expect(IGNORED_DIR_PATTERN.test('/repo/packages/api/node_modules/lodash/index.js')).toBe(true)
  })

  it('does not prune ordinary source paths', () => {
    for (const path of [
      '/repo/src/features/chat/MessageList.tsx',
      '/repo/electron/fs/git-info.ts',
      '/repo/distribution/service.ts', // substring of "dist", must NOT match
      '/repo/src/outbound/client.ts', // substring of "out", must NOT match
    ]) {
      expect(IGNORED_DIR_PATTERN.test(path)).toBe(false)
    }
  })

  it('keeps the depth cap shallow enough to stay responsive', () => {
    // At depth 4 the same repo cost 3,354 dirs / 523ms; at 6, over two minutes.
    expect(MAX_WATCH_DEPTH).toBeLessThanOrEqual(4)
  })

  it('keeps the process-wide fd budget below macOS libuv’s spawn limit', () => {
    // libuv uses an internal 10,240-fd table on macOS. Its failure mode above
    // that is the misleading `spawn EBADF`, not EMFILE, so leave room for
    // Electron, PTYs, session watchers and pi's three stdio pipes.
    expect(MAX_WATCHED_PATHS).toBeLessThanOrEqual(6_000)
    expect(MAX_DIR_ENTRIES).toBeLessThan(MAX_WATCHED_PATHS)
  })
})

describe('createWatchFilter', () => {
  it('shares a bounded process-wide budget across workspace filters', () => {
    const budget = new WatchBudget(1)
    const first = createWatchFilter('/first', () => false, budget)
    const second = createWatchFilter('/second', () => false, budget)

    expect(first.ignored('/first/a.ts', fileStats)).toBe(false)
    expect(second.ignored('/second/b.ts', fileStats)).toBe(true)
    first.releaseAll()
    expect(second.ignored('/second/b.ts', fileStats)).toBe(false)
  })
  it('never ignores the watch root', () => {
    // Ignoring the root watches nothing at all — the failure this must not
    // trade the EMFILE for. True even for a root whose own name is prunable.
    const filter = createWatchFilter('/repo/build', () => true)
    expect(filter.ignored('/repo/build', dirStats)).toBe(false)
  })

  it('skips a dump directory whole instead of watching every file in it', () => {
    const isOversized = vi.fn((dir: string) => dir.endsWith('/captures'))
    const filter = createWatchFilter('/repo', isOversized)

    expect(filter.ignored('/repo/.overrides-local/workflow-retries/captures', dirStats)).toBe(true)
    expect(filter.ignored('/repo/src', dirStats)).toBe(false)
    // Skipped whole means it costs nothing, not 2,000 fds.
    expect(filter.size).toBe(1)
  })

  it('only probes directories, never files', () => {
    const isOversized = vi.fn(() => false)
    const filter = createWatchFilter('/repo', isOversized)

    filter.ignored('/repo/src/index.ts', fileStats)
    expect(isOversized).not.toHaveBeenCalled()

    filter.ignored('/repo/src', dirStats)
    expect(isOversized).toHaveBeenCalledWith('/repo/src')
  })

  it('stops granting slots once the budget is spent', () => {
    const filter = createWatchFilter('/repo', () => false)
    for (let i = 0; i < MAX_WATCHED_PATHS; i++) {
      expect(filter.ignored(`/repo/src/file-${i}.ts`, fileStats)).toBe(false)
    }
    expect(filter.size).toBe(MAX_WATCHED_PATHS)
    expect(filter.ignored('/repo/src/one-too-many.ts', fileStats)).toBe(true)
  })

  it('keeps answering "watch it" for a path already granted a slot', () => {
    // chokidar asks about the same path more than once. A path that flipped
    // to ignored after the budget filled would read as a deletion.
    const filter = createWatchFilter('/repo', () => false)
    filter.ignored('/repo/src/index.ts', fileStats)
    for (let i = 0; i < MAX_WATCHED_PATHS; i++) {
      filter.ignored(`/repo/src/file-${i}.ts`, fileStats)
    }
    expect(filter.ignored('/repo/src/index.ts', fileStats)).toBe(false)
    expect(filter.ignored('/repo/src/index.ts')).toBe(false)
  })

  it('does not spend budget twice on one path', () => {
    // chokidar asks once with stats (readdirp) and once without
    // (_addToNodeFs). Counting both would halve the real budget.
    const filter = createWatchFilter('/repo', () => false)
    filter.ignored('/repo/src/index.ts', fileStats)
    filter.ignored('/repo/src/index.ts')
    filter.ignored('/repo/src/index.ts', fileStats)
    expect(filter.size).toBe(1)
  })

  it('hands a deleted path its slot back', () => {
    // Without this a long session in a churning repo drains the budget and
    // silently stops watching anything new.
    const filter = createWatchFilter('/repo', () => false)
    for (let i = 0; i < MAX_WATCHED_PATHS; i++) {
      filter.ignored(`/repo/src/file-${i}.ts`, fileStats)
    }
    expect(filter.ignored('/repo/src/new.ts', fileStats)).toBe(true)

    filter.release('/repo/src/file-0.ts')
    expect(filter.size).toBe(MAX_WATCHED_PATHS - 1)
    expect(filter.ignored('/repo/src/new.ts', fileStats)).toBe(false)
  })

  it('applies the prune list before spending any budget', () => {
    const isOversized = vi.fn(() => false)
    const filter = createWatchFilter('/repo', isOversized)
    expect(filter.ignored('/repo/node_modules/lodash/index.js', fileStats)).toBe(true)
    expect(filter.size).toBe(0)
    expect(isOversized).not.toHaveBeenCalled()
  })
})

describe('createWatchFilter prune scoping', () => {
  it('prunes on the path relative to the workspace, not the absolute one', () => {
    // A repo under a directory named like a build output must still be
    // watched. Matching the absolute path pruned every file it owns and left
    // the explorer with a watcher bound to nothing.
    const filter = createWatchFilter('/Users/me/build/myapp', () => false)
    expect(filter.ignored('/Users/me/build/myapp/src/index.ts', fileStats)).toBe(false)
    expect(filter.ignored('/Users/me/build/myapp/build/out.js', fileStats)).toBe(true)
  })

  it('still prunes the workspace’s own heavy directories', () => {
    const filter = createWatchFilter('/private/tmp/repo', () => false)
    expect(filter.ignored('/private/tmp/repo/src/index.ts', fileStats)).toBe(false)
    expect(filter.ignored('/private/tmp/repo/node_modules/x/i.js', fileStats)).toBe(true)
  })
})
