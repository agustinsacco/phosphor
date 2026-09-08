import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addWorktree,
  commitAll,
  isBranchMerged,
  listBranches,
  listWorktrees,
  mergeBranch,
  parseWorktreeList,
  pruneWorktrees,
  removeWorktree,
  renameBranch,
  startPoint,
  worktreeRootFor,
} from './git-worktrees'

const execFileAsync = promisify(execFile)

let repo: string

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'phosphor-wt-'))
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['config', 'user.email', 'test@phosphor.dev'])
  await git(repo, ['config', 'user.name', 'Phosphor test'])
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', 'initial'])
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('parseWorktreeList', () => {
  it('parses main + linked + detached + prunable entries', () => {
    const parsed = parseWorktreeList(
      [
        'worktree /repo',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        'worktree /repo/.phosphor/worktrees/task',
        'HEAD 2222222222222222222222222222222222222222',
        'branch refs/heads/task',
        'locked reason',
        '',
        'worktree /repo/.phosphor/worktrees/gone',
        'HEAD 3333333333333333333333333333333333333333',
        'detached',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    )
    expect(parsed).toHaveLength(3)
    expect(parsed[0]).toMatchObject({ path: '/repo', branch: 'main', locked: false })
    expect(parsed[1]).toMatchObject({ branch: 'task', locked: true })
    expect(parsed[2]).toMatchObject({ branch: null, prunable: true })
  })
})

describe('git-worktrees (real git)', () => {
  it('adds a worktree on a new branch and excludes /.phosphor/', async () => {
    const created = await addWorktree(repo, 'task-1', { kind: 'new', base: 'main' })
    expect(created.branch).toBe('task-1')
    expect(created.isMain).toBe(false)
    expect(existsSync(join(worktreeRootFor(repo), 'task-1'))).toBe(true)

    // /.phosphor/ excluded → main status stays clean.
    expect(await git(repo, ['status', '--porcelain'])).toBe('')
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('/.phosphor/')

    // Idempotent exclude append.
    await addWorktree(repo, 'task-2', { kind: 'new', base: 'main' })
    const exclude2 = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude2.match(/\/\.phosphor\//g)).toHaveLength(1)
  })

  it('refuses names with path separators traversal and duplicates', async () => {
    await expect(addWorktree(repo, '../evil', { kind: 'new', base: 'main' })).rejects.toThrow(
      /Invalid worktree name/,
    )
    await addWorktree(repo, 'task-1', { kind: 'new', base: 'main' })
    await expect(addWorktree(repo, 'task-1', { kind: 'new', base: 'main' })).rejects.toThrow()
  })

  it('opens an existing branch as a worktree, refusing already-checked-out ones', async () => {
    await git(repo, ['branch', 'feature-x'])
    const created = await addWorktree(repo, 'feature-x', { kind: 'existing', branch: 'feature-x' })
    expect(created.branch).toBe('feature-x')
    await expect(
      addWorktree(repo, 'feature-x-2', { kind: 'existing', branch: 'main' }),
    ).rejects.toThrow(/already checked out/)
  })

  it('refuses the default branch even when it is not currently checked out', async () => {
    // The regression: git only blocks a branch that is checked out *right now*,
    // so from a feature branch `main` looks free and git would move it into a
    // worktree — after which the main tree can never check it out again.
    await git(repo, ['checkout', '-b', 'feature-y'])
    await expect(addWorktree(repo, 'trunk', { kind: 'existing', branch: 'main' })).rejects.toThrow(
      /default branch/,
    )
    // And it is not a blanket ban on existing branches from here.
    await git(repo, ['branch', 'feature-z'])
    const created = await addWorktree(repo, 'feature-z', {
      kind: 'existing',
      branch: 'feature-z',
    })
    expect(created.branch).toBe('feature-z')
  })

  it('lists branches with worktree associations and a default', async () => {
    await addWorktree(repo, 'task-1', { kind: 'new', base: 'main' })
    const { branches, defaultBranch } = await listBranches(repo)
    expect(defaultBranch).toBe('main')
    const task = branches.find((b) => b.name === 'task-1')
    expect(task?.worktreePath).toContain('task-1')
    expect(branches.find((b) => b.name === 'main')?.isCurrent).toBe(true)
  })

  it('guards dirty worktrees on remove, honors force, and -d only for branches', async () => {
    const created = await addWorktree(repo, 'task-1', { kind: 'new', base: 'main' })
    await writeFile(join(created.path, 'b.txt'), 'uncommitted\n')

    const refused = await removeWorktree(repo, created.path, {})
    expect(refused).toEqual({ removed: false, dirtyCount: 1 })
    expect(existsSync(created.path)).toBe(true)

    // Forced: removed, but the (unmerged-with-nothing) branch survives -d
    // only if merged; task-1 points at main's HEAD so -d succeeds.
    const removed = await removeWorktree(repo, created.path, { force: true, deleteBranch: true })
    expect(removed).toMatchObject({ removed: true, branchDeleted: true })
    expect(existsSync(created.path)).toBe(false)
  })

  it('keeps unmerged branches on delete and reports the error', async () => {
    const created = await addWorktree(repo, 'task-1', { kind: 'new', base: 'main' })
    await writeFile(join(created.path, 'c.txt'), 'work\n')
    await commitAll(created.path, 'work on task-1')

    const result = await removeWorktree(repo, created.path, { deleteBranch: true })
    expect(result).toMatchObject({ removed: true, branchDeleted: false })
    if (result.removed) expect(result.branchError).toBeTruthy()
    expect(await git(repo, ['branch', '--list', 'task-1'])).toContain('task-1')
  })

  it('deletes a squash-merged branch, which plain -d refuses', async () => {
    // The exact shape of a merged Phosphor lane: the PR squashes the branch's
    // commits into one new commit on main, so the branch is not an ancestor
    // and `git branch -d` refuses it even though nothing would be lost.
    const created = await addWorktree(repo, 'task-1', { kind: 'new', base: 'main' })
    await writeFile(join(created.path, 'c.txt'), 'work\n')
    await commitAll(created.path, 'first')
    await writeFile(join(created.path, 'd.txt'), 'more\n')
    await commitAll(created.path, 'second')

    await git(repo, ['merge', '--squash', 'task-1'])
    await git(repo, ['commit', '-m', 'squashed task-1 (#1)'])
    await expect(git(repo, ['branch', '-d', 'task-1'])).rejects.toThrow()
    expect(await isBranchMerged(repo, 'task-1')).toBe(true)

    const result = await removeWorktree(repo, created.path, { deleteBranch: true })
    expect(result).toMatchObject({ removed: true, branchDeleted: true })
    if (result.removed) expect(result.branchError).toBeUndefined()
    expect(await git(repo, ['branch', '--list', 'task-1'])).toBe('')
  })

  it('reports an unmerged branch in git\'s own words, not "Command failed"', async () => {
    const created = await addWorktree(repo, 'task-1', { kind: 'new', base: 'main' })
    await writeFile(join(created.path, 'c.txt'), 'work\n')
    await commitAll(created.path, 'work on task-1')

    expect(await isBranchMerged(repo, 'task-1')).toBe(false)
    const result = await removeWorktree(repo, created.path, { deleteBranch: true })
    expect(result).toMatchObject({ removed: true, branchDeleted: false })
    if (result.removed) {
      expect(result.branchError).toMatch(/not fully merged/)
      expect(result.branchError).not.toMatch(/Command failed|hint:/)
    }
  })

  it('prunes after a manual folder delete', async () => {
    const created = await addWorktree(repo, 'task-1', { kind: 'new', base: 'main' })
    await rm(created.path, { recursive: true, force: true })
    const { pruned } = await pruneWorktrees(repo)
    expect(pruned.length).toBeGreaterThan(0)
    expect((await listWorktrees(repo)).some((w) => w.branch === 'task-1')).toBe(false)
  })

  it('merges a committed worktree branch with --no-ff', async () => {
    const created = await addWorktree(repo, 'task-1', { kind: 'new', base: 'main' })
    await writeFile(join(created.path, 'c.txt'), 'work\n')
    const { sha } = await commitAll(created.path, 'task work')
    expect(sha).toHaveLength(40)

    const result = await mergeBranch(repo, 'task-1')
    expect(result).toMatchObject({ merged: true })
    expect(existsSync(join(repo, 'c.txt'))).toBe(true)
    // --no-ff → merge commit with two parents.
    expect((await git(repo, ['rev-list', '--parents', '-1', 'HEAD'])).split(' ')).toHaveLength(3)
  })

  it('refuses to merge onto a dirty main tree', async () => {
    await addWorktree(repo, 'task-1', { kind: 'new', base: 'main' })
    await writeFile(join(repo, 'a.txt'), 'local edit\n')
    const result = await mergeBranch(repo, 'task-1')
    expect(result).toMatchObject({ merged: false, reason: 'dirty' })
  })

  it('aborts conflicting merges cleanly (no MERGE_HEAD left)', async () => {
    const created = await addWorktree(repo, 'task-1', { kind: 'new', base: 'main' })
    await writeFile(join(created.path, 'a.txt'), 'worktree version\n')
    await commitAll(created.path, 'worktree edit')
    await writeFile(join(repo, 'a.txt'), 'main version\n')
    await git(repo, ['commit', '-am', 'main edit'])

    const result = await mergeBranch(repo, 'task-1')
    expect(result).toMatchObject({ merged: false, reason: 'conflict' })
    if (!result.merged && result.reason === 'conflict') {
      expect(result.conflicts).toContain('a.txt')
    }
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(await git(repo, ['status', '--porcelain'])).toBe('')
  })

  it('commitAll refuses empty messages', async () => {
    await expect(commitAll(repo, '   ')).rejects.toThrow(/empty/)
  })

  it('creates a branch whose name differs from the worktree folder', async () => {
    // Auto-created session branches are prefixed (`phosphor/…`) but their folder
    // cannot be — the basename names the sidebar group, and a `/` would nest
    // the checkout a level deeper.
    const created = await addWorktree(repo, 'session-naming', {
      kind: 'new',
      base: 'main',
      branch: 'phosphor/session-naming',
    })
    expect(created.branch).toBe('phosphor/session-naming')
    expect(created.path.endsWith(join('worktrees', 'session-naming'))).toBe(true)
    expect(existsSync(join(worktreeRootFor(repo), 'session-naming'))).toBe(true)
  })

  it('rejects a ref-hostile explicit branch name', async () => {
    await expect(
      addWorktree(repo, 'ok-name', { kind: 'new', base: 'main', branch: '../../evil' }),
    ).rejects.toThrow(/Invalid branch name/)
  })

  it('startPoint falls back to local trunk without a remote', async () => {
    const point = await startPoint(repo)
    expect(point).toEqual({ base: 'main', defaultBranch: 'main', fromRemote: false })
  })
})

/**
 * The origin-based start point needs a real remote-tracking ref, so this block
 * clones the fixture repo the way `git-sync.test.ts` does. The behaviour under
 * test is precisely that a new branch starts from `origin/main` rather than
 * from the clone's own (deliberately stale) `main`.
 */
describe('renameBranch (real git)', () => {
  /**
   * The case that matters: a chat's branch is cut before its name is known, so
   * the rename always lands on a branch a live worktree has checked out.
   */
  it('renames a branch checked out in a linked worktree, and the worktree follows', async () => {
    await addWorktree(repo, 'slug-folder', {
      kind: 'new',
      base: 'HEAD',
      branch: 'phosphor/read-each-of-the-12-largest-files',
    })
    const path = join(worktreeRootFor(repo), 'slug-folder')

    const result = await renameBranch(
      repo,
      'phosphor/read-each-of-the-12-largest-files',
      'phosphor/tsx-file-survey',
    )

    expect(result).toEqual({ renamed: true, branch: 'phosphor/tsx-file-survey' })
    expect(await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('phosphor/tsx-file-survey')
    // The folder deliberately does NOT move: it is a live session's cwd.
    expect(existsSync(path)).toBe(true)
    // Matched on `realPath` as well as `path`, the way every production
    // lookup does (see `addWorktree` / `removeWorktree`): on macOS the temp
    // dir is a symlink, so git reports `/private/var/...` where `path` says
    // `/var/...` and a path-only match never found the row.
    const worktrees = await listWorktrees(repo)
    const created = worktrees.find(
      (w) => w.path === path || w.realPath === realpathSync.native(path),
    )
    expect(created?.branch).toBe('phosphor/tsx-file-survey')
  })

  it('reports failure instead of throwing when the target name is taken', async () => {
    await git(repo, ['branch', 'phosphor/taken'])
    await git(repo, ['branch', 'phosphor/original'])

    expect(await renameBranch(repo, 'phosphor/original', 'phosphor/taken')).toEqual({
      renamed: false,
      branch: 'phosphor/original',
    })
    // Neither branch was disturbed — `-m` refuses rather than clobbering.
    const names = (await listBranches(repo)).branches.map((b) => b.name)
    expect(names).toContain('phosphor/original')
    expect(names).toContain('phosphor/taken')
  })

  it('refuses ref-hostile targets without invoking git', async () => {
    await git(repo, ['branch', 'phosphor/original'])
    for (const hostile of ['bad..name', '-leading-dash', 'has space', 'tilde~1']) {
      expect(await renameBranch(repo, 'phosphor/original', hostile)).toEqual({
        renamed: false,
        branch: 'phosphor/original',
      })
    }
    expect((await listBranches(repo)).branches.map((b) => b.name)).toContain('phosphor/original')
  })

  it('is a no-op when the name is already right', async () => {
    await git(repo, ['branch', 'phosphor/same'])
    expect(await renameBranch(repo, 'phosphor/same', 'phosphor/same')).toEqual({
      renamed: false,
      branch: 'phosphor/same',
    })
  })
})

describe('startPoint with a remote (real git)', () => {
  let origin: string
  let clone: string

  beforeEach(async () => {
    origin = repo
    clone = await mkdtemp(join(tmpdir(), 'phosphor-wt-clone-'))
    await execFileAsync('git', ['clone', '--quiet', origin, clone])
    await git(clone, ['config', 'user.email', 'test@phosphor.dev'])
    await git(clone, ['config', 'user.name', 'Phosphor test'])
  })

  afterEach(async () => {
    await rm(clone, { recursive: true, force: true })
  })

  it('prefers origin/main and branches off it even when local main is stale', async () => {
    // A commit lands on the remote; the clone fetches but never pulls, so its
    // local `main` is now a commit behind — the everyday state of a repo you
    // have been working in.
    await writeFile(join(origin, 'b.txt'), 'two\n')
    await git(origin, ['add', '-A'])
    await git(origin, ['commit', '-m', 'second'])
    await git(clone, ['fetch', '--quiet'])

    const point = await startPoint(clone)
    expect(point).toEqual({ base: 'origin/main', defaultBranch: 'main', fromRemote: true })

    const created = await addWorktree(clone, 'fresh', {
      kind: 'new',
      base: point.base,
      branch: 'phosphor/fresh',
      noTrack: true,
    })
    // The new branch has the remote's newest commit; local main does not — the
    // whole point of preferring origin/main over the stale local trunk.
    expect(existsSync(join(created.path, 'b.txt'))).toBe(true)
    expect(await git(clone, ['rev-parse', 'phosphor/fresh'])).toBe(
      await git(clone, ['rev-parse', 'origin/main']),
    )
    expect(await git(clone, ['rev-parse', 'main'])).not.toBe(
      await git(clone, ['rev-parse', 'origin/main']),
    )
  })

  it('noTrack keeps origin/main from becoming the new branch upstream', async () => {
    await addWorktree(clone, 'tracked', { kind: 'new', base: 'origin/main', branch: 'phosphor/t' })
    await addWorktree(clone, 'untracked', {
      kind: 'new',
      base: 'origin/main',
      branch: 'phosphor/u',
      noTrack: true,
    })
    // Without --no-track git adopts origin/main as upstream, which would make
    // the branch chip measure the session against trunk and point `git push`
    // at main. With it, the branch simply has no upstream.
    expect(
      await git(clone, ['for-each-ref', '--format=%(upstream:short)', 'refs/heads/phosphor/t']),
    ).toBe('origin/main')
    expect(
      await git(clone, ['for-each-ref', '--format=%(upstream:short)', 'refs/heads/phosphor/u']),
    ).toBe('')
  })
})
