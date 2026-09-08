import { describe, expect, it } from 'vitest'
import type { GitInfo, SessionMeta } from '@shared/models'
import { groupSessionsByProject, pendingSessionsByGroup } from './groupSessions'

const meta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  path: '/s.jsonl',
  sessionId: 's',
  cwd: '/repo',
  createdAt: '2026-08-09T00:00:00.000Z',
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  totalTokens: 100,
  inputTokens: 60,
  outputTokens: 40,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  entryCount: 2,
  branchCount: 0,
  mtimeMs: Date.now(),
  lastActivityAt: '2026-08-09T00:01:00.000Z',
  ...overrides,
})

const notPinned = (): boolean => false
const notLive = (): boolean => false

describe('groupSessionsByProject', () => {
  it('gives a plain workspace its own group', () => {
    const groups = groupSessionsByProject(
      ['/repo'],
      { '/repo': [meta({ path: '/repo/a.jsonl' })] },
      {},
      notPinned,
      notLive,
      '/repo',
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ workspacePath: '/repo', paths: ['/repo'], name: 'repo' })
  })

  it('folds an externally-placed worktree via its known root, before git info lands', () => {
    // The startup bug: `git worktree list` reports worktrees anywhere on
    // disk, but only `<repo>/.phosphor/worktrees/` is recognisable from the path
    // alone. Every other one opened its own branch-named group for as long as
    // `git:infoBatch` took — a wall of fake "workspaces" on every cold start.
    const known = [
      '/repo',
      '/tmp/pr15889-wt',
      '/repo/.claude/worktrees/blissful',
      '/src/repo-know719',
    ]
    const worktreeRoots = {
      '/tmp/pr15889-wt': '/repo',
      '/repo/.claude/worktrees/blissful': '/repo',
      '/src/repo-know719': '/repo',
    }
    const groups = groupSessionsByProject(
      known,
      { '/repo': [meta({ path: '/repo/a.jsonl' })] },
      {}, // no git info yet — this is the first paint
      notPinned,
      notLive,
      '/repo',
      {},
      worktreeRoots,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ workspacePath: '/repo', name: 'repo' })
    expect(groups[0]!.paths).toEqual(known)
  })

  it('shows a branch-named group for each worktree when the roots are missing', () => {
    // Guards the fix above: without `worktreeRoots` the same input is four
    // groups, which is exactly what the user saw.
    const groups = groupSessionsByProject(
      ['/repo', '/tmp/pr15889-wt', '/src/repo-know719'],
      { '/repo': [meta({ path: '/repo/a.jsonl' })] },
      {},
      notPinned,
      notLive,
      '/repo',
    )
    expect(groups.map((g) => g.name)).toEqual(['repo', 'pr15889-wt', 'repo-know719'])
  })

  it('folds a linked worktree into its main repo group instead of a second header', () => {
    const gitByCwd: Record<string, GitInfo> = {
      '/repo': { isRepo: true, branch: 'main' },
      '/repo/.phosphor/worktrees/test': {
        isRepo: true,
        branch: 'test',
        isWorktree: true,
        mainRepoPath: '/repo',
      },
    }
    const disk = {
      '/repo': [meta({ path: '/repo/a.jsonl', cwd: '/repo', mtimeMs: 1000 })],
      '/repo/.phosphor/worktrees/test': [
        meta({
          path: '/repo/.phosphor/worktrees/test/b.jsonl',
          cwd: '/repo/.phosphor/worktrees/test',
          createdAt: '2026-08-10T00:00:00.000Z',
          mtimeMs: 2000,
        }),
      ],
    }
    const groups = groupSessionsByProject(
      ['/repo', '/repo/.phosphor/worktrees/test'],
      disk,
      gitByCwd,
      notPinned,
      notLive,
      '/repo',
    )

    // One header, not two — this is the bug report: a worktree used to split
    // the sidebar into "repo" and "repo (test)".
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('repo')
    expect(groups[0]?.paths.sort()).toEqual(['/repo', '/repo/.phosphor/worktrees/test'].sort())
    // Sessions from both physical folders show up under the merged group,
    // newest-created first, each still carrying its own (worktree) cwd.
    expect(groups[0]?.metas.map((m) => m.cwd)).toEqual(['/repo/.phosphor/worktrees/test', '/repo'])
  })

  it('folds a worktree in before its git info arrives', () => {
    // `git:infoBatch` is a round trip, so every surface renders at least once
    // with `gitByCwd` empty for a freshly created worktree. Keying on git info
    // alone opened a second group headed by the branch slug, which then
    // collapsed into the project group a moment later.
    const groups = groupSessionsByProject(
      ['/repo', '/repo/.phosphor/worktrees/hey-2'],
      {
        '/repo': [meta({ path: '/repo/a.jsonl', cwd: '/repo' })],
        '/repo/.phosphor/worktrees/hey-2': [
          meta({
            path: '/repo/.phosphor/worktrees/hey-2/b.jsonl',
            cwd: '/repo/.phosphor/worktrees/hey-2',
          }),
        ],
      },
      {},
      notPinned,
      notLive,
      '/repo',
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('repo')
    expect(groups[0]?.workspacePath).toBe('/repo')
  })

  it('falls back to the worktree path when the main repo folder is unknown', () => {
    const gitByCwd: Record<string, GitInfo> = {
      '/somewhere/wt': { isRepo: true, branch: 'test', isWorktree: true, mainRepoPath: '/repo' },
    }
    const groups = groupSessionsByProject(
      ['/somewhere/wt'],
      { '/somewhere/wt': [meta({ path: '/somewhere/wt/a.jsonl', cwd: '/somewhere/wt' })] },
      gitByCwd,
      notPinned,
      notLive,
      '/somewhere/wt',
    )
    expect(groups).toHaveLength(1)
    // Grouped under the (unopened) main repo's name, but the only known
    // physical folder is still the worktree, so that's the action target.
    expect(groups[0]?.name).toBe('repo')
    expect(groups[0]?.workspacePath).toBe('/somewhere/wt')
  })

  it('keeps separate projects in the supplied workspace order', () => {
    const groups = groupSessionsByProject(
      ['/repo-b', '/repo-a'],
      { '/repo-a': [meta({ cwd: '/repo-a' })], '/repo-b': [meta({ cwd: '/repo-b' })] },
      {},
      notPinned,
      notLive,
      '/repo-a',
    )
    expect(groups.map((g) => g.name)).toEqual(['repo-b', 'repo-a'])
  })

  it('does not promote active, live, or recently changed workspaces', () => {
    const groups = groupSessionsByProject(
      ['/repo-a', '/repo-b', '/repo-c'],
      {
        '/repo-a': [meta({ cwd: '/repo-a', mtimeMs: 100 })],
        '/repo-b': [meta({ cwd: '/repo-b', mtimeMs: 300 })],
        '/repo-c': [meta({ cwd: '/repo-c', mtimeMs: 200 })],
      },
      {},
      notPinned,
      (session) => session.cwd === '/repo-b',
      '/repo-c',
    )
    expect(groups.map((group) => group.workspacePath)).toEqual(['/repo-a', '/repo-b', '/repo-c'])
  })

  it('keeps session rows in creation order when older sessions get new activity', () => {
    const sessions = groupSessionsByProject(
      ['/repo'],
      {
        '/repo': [
          meta({
            path: '/repo/older.jsonl',
            createdAt: '2026-08-01T00:00:00.000Z',
            mtimeMs: 300,
          }),
          meta({
            path: '/repo/newer.jsonl',
            createdAt: '2026-08-02T00:00:00.000Z',
            mtimeMs: 100,
          }),
        ],
      },
      {},
      notPinned,
      notLive,
      '/repo',
    )

    expect(sessions[0]?.metas.map((session) => session.path)).toEqual([
      '/repo/newer.jsonl',
      '/repo/older.jsonl',
    ])
  })

  it('excludes pinned sessions and counts live sessions per merged group', () => {
    const pinned = meta({ path: '/repo/pinned.jsonl' })
    const live = meta({ path: '/repo/live.jsonl' })
    const groups = groupSessionsByProject(
      ['/repo'],
      { '/repo': [pinned, live] },
      {},
      (m) => m.path === pinned.path,
      (m) => m.path === live.path,
      '/repo',
    )
    expect(groups[0]?.metas.map((m) => m.path)).toEqual([live.path])
    expect(groups[0]?.liveCount).toBe(1)
  })

  it('is attempted only once every folder in the group has had a scan', () => {
    const gitByCwd: Record<string, GitInfo> = {
      '/repo': { isRepo: true, branch: 'main' },
      '/repo/.phosphor/worktrees/test': {
        isRepo: true,
        branch: 'test',
        isWorktree: true,
        mainRepoPath: '/repo',
      },
    }
    const groups = groupSessionsByProject(
      ['/repo', '/repo/.phosphor/worktrees/test'],
      {},
      gitByCwd,
      notPinned,
      notLive,
      '/repo',
      { '/repo': 'ok' },
    )
    // The main repo scanned (empty) but the merged worktree has not — the
    // group must still read as loading, not as definitively empty.
    expect(groups[0]?.attempted).toBe(false)
    expect(groups[0]?.errored).toBe(false)
  })

  it("flags a group once a merged folder's scan threw", () => {
    const gitByCwd: Record<string, GitInfo> = {
      '/repo': { isRepo: true, branch: 'main' },
      '/repo/.phosphor/worktrees/test': {
        isRepo: true,
        branch: 'test',
        isWorktree: true,
        mainRepoPath: '/repo',
      },
    }
    const groups = groupSessionsByProject(
      ['/repo', '/repo/.phosphor/worktrees/test'],
      {},
      gitByCwd,
      notPinned,
      notLive,
      '/repo',
      { '/repo': 'ok', '/repo/.phosphor/worktrees/test': 'error' },
    )
    expect(groups[0]?.attempted).toBe(true)
    expect(groups[0]?.errored).toBe(true)
  })
})

/**
 * The collapse default used to key off `scanned`, which is AND-ed across every
 * folder merged into the group. Lanes are discovered asynchronously, so adding
 * one flipped `scanned` false and slammed an already-open group shut — which
 * also unwatched it. `anyScanned` is what the default keys off now.
 */
describe('scan bookkeeping across a merged group', () => {
  const gitByCwd: Record<string, GitInfo> = {
    '/repo': { isRepo: true, branch: 'main' },
    '/repo/.phosphor/worktrees/lane': {
      isRepo: true,
      branch: 'lane',
      isWorktree: true,
      mainRepoPath: '/repo',
    },
  }

  it('stays anyScanned when a freshly discovered lane is still unscanned', () => {
    const groups = groupSessionsByProject(
      ['/repo', '/repo/.phosphor/worktrees/lane'],
      { '/repo': [meta({ path: '/repo/a.jsonl' })] },
      gitByCwd,
      notPinned,
      notLive,
      '/elsewhere',
      { '/repo': 'ok' },
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ scanned: false, anyScanned: true, attempted: false })
  })

  it('names the folders still to scan', () => {
    const groups = groupSessionsByProject(
      ['/repo', '/repo/.phosphor/worktrees/lane'],
      { '/repo': [] },
      gitByCwd,
      notPinned,
      notLive,
      '/elsewhere',
      { '/repo': 'ok' },
    )
    expect(groups[0]!.unscannedPaths).toEqual(['/repo/.phosphor/worktrees/lane'])
  })

  it('has nothing left to scan once every folder has been attempted', () => {
    const groups = groupSessionsByProject(
      ['/repo', '/repo/.phosphor/worktrees/lane'],
      { '/repo': [], '/repo/.phosphor/worktrees/lane': [] },
      gitByCwd,
      notPinned,
      notLive,
      // The active workspace, so a fully scanned but empty group still gets a
      // header — an empty non-active group is filtered out by design.
      '/repo',
      { '/repo': 'ok', '/repo/.phosphor/worktrees/lane': 'ok' },
    )
    expect(groups[0]).toMatchObject({ scanned: true, anyScanned: true, attempted: true })
    expect(groups[0]!.unscannedPaths).toEqual([])
  })

  it('counts an errored folder as attempted, so it is not retried as "missing"', () => {
    const groups = groupSessionsByProject(
      ['/repo'],
      {},
      gitByCwd,
      notPinned,
      notLive,
      '/elsewhere',
      { '/repo': 'error' },
    )
    expect(groups[0]).toMatchObject({ attempted: true, errored: true, anyScanned: false })
    expect(groups[0]!.unscannedPaths).toEqual([])
  })

  it('lists every lane of the group so an expanded group can scan them all', () => {
    const lanes = Array.from({ length: 12 }, (_, i) => `/repo/.phosphor/worktrees/l${i}`)
    const git: Record<string, GitInfo> = { '/repo': { isRepo: true, branch: 'main' } }
    for (const lane of lanes) {
      git[lane] = { isRepo: true, branch: 'l', isWorktree: true, mainRepoPath: '/repo' }
    }
    const groups = groupSessionsByProject(
      ['/repo', ...lanes],
      { '/repo': [] },
      git,
      notPinned,
      notLive,
      '/elsewhere',
      { '/repo': 'ok' },
    )
    expect(groups[0]!.unscannedPaths).toEqual(lanes)
  })
})

describe('pendingSessionsByGroup', () => {
  const groups = [{ workspacePath: '/repo', paths: ['/repo'] }]

  it('is pending while diskPath is unknown', () => {
    const live = [{ phosphorId: 'p1', workspacePath: '/repo' }]
    const pending = pendingSessionsByGroup(live, new Set(), groups)
    expect(pending.get('/repo')).toEqual(['p1'])
  })

  it('stays pending once diskPath is known but the scan has not caught up yet', () => {
    // Regression: get_state can resolve `diskPath` well before pi's file
    // shows up in a `disk` scan (write + watcher awaitWriteFinish + debounce
    // all still have to happen). Gating on "diskPath known" alone dropped the
    // placeholder during that gap and left the row missing.
    const live = [{ phosphorId: 'p1', workspacePath: '/repo', diskPath: '/repo/a.jsonl' }]
    const pending = pendingSessionsByGroup(live, new Set(), groups)
    expect(pending.get('/repo')).toEqual(['p1'])
  })

  it('drops out once the disk scan actually contains the session', () => {
    const live = [{ phosphorId: 'p1', workspacePath: '/repo', diskPath: '/repo/a.jsonl' }]
    const pending = pendingSessionsByGroup(live, new Set(['/repo/a.jsonl']), groups)
    expect(pending.has('/repo')).toBe(false)
  })

  it('keys a pending worktree session by its main-repo group, not its own path', () => {
    const foldedGroups = [
      { workspacePath: '/repo', paths: ['/repo', '/repo/.phosphor/worktrees/test'] },
    ]
    const live = [{ phosphorId: 'p1', workspacePath: '/repo/.phosphor/worktrees/test' }]
    const pending = pendingSessionsByGroup(live, new Set(), foldedGroups)
    expect(pending.get('/repo')).toEqual(['p1'])
  })
})
