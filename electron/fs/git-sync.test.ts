import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addWorktree, listBranches } from './git-worktrees'
import {
  checkoutBranch,
  fetchRepo,
  pullFastForward,
  resetFetchThrottle,
  updateFromMain,
} from './git-sync'

/**
 * Real git in temp dirs, matching git-worktrees.test.ts. A local "remote" (a
 * second clone) is enough to exercise fetch/pull for real: the behaviour that
 * matters here is ff-only refusal and the dirty/held guards, none of which
 * cares whether the remote is over a network.
 */

const execFileAsync = promisify(execFile)

let origin: string
let repo: string

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

async function commit(cwd: string, file: string, body: string): Promise<void> {
  await writeFile(join(cwd, file), body)
  await git(cwd, ['add', '-A'])
  await git(cwd, ['commit', '-m', `add ${file}`])
}

beforeEach(async () => {
  resetFetchThrottle()

  origin = await mkdtemp(join(tmpdir(), 'phosphor-origin-'))
  await git(origin, ['init', '-b', 'main'])
  await git(origin, ['config', 'user.email', 'test@phosphor.dev'])
  await git(origin, ['config', 'user.name', 'Phosphor test'])
  await commit(origin, 'a.txt', 'one\n')

  repo = await mkdtemp(join(tmpdir(), 'phosphor-clone-'))
  await rm(repo, { recursive: true, force: true })
  await execFileAsync('git', ['clone', origin, repo])
  await git(repo, ['config', 'user.email', 'test@phosphor.dev'])
  await git(repo, ['config', 'user.name', 'Phosphor test'])
})

afterEach(async () => {
  await rm(origin, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

describe('fetchRepo', () => {
  it('fetches, then throttles the next call for the same repo', async () => {
    const first = await fetchRepo(repo)
    expect(first.fetched).toBe(true)

    const second = await fetchRepo(repo)
    expect(second).toMatchObject({ fetched: false, reason: 'throttled' })

    // `force` is what the explicit refresh affordance uses.
    expect(await fetchRepo(repo, { force: true })).toMatchObject({ fetched: true })
  })

  it('reports an unreachable remote as failed instead of throwing', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'phosphor-broken-'))
    try {
      await git(broken, ['init', '-b', 'main'])
      await git(broken, ['remote', 'add', 'origin', join(tmpdir(), 'phosphor-does-not-exist')])

      expect(await fetchRepo(broken)).toMatchObject({ fetched: false, reason: 'failed' })
      // A failed fetch must not poison the throttle: the next call retries
      // rather than sitting out the full TTL reporting "throttled".
      expect(await fetchRepo(broken)).toMatchObject({ fetched: false, reason: 'failed' })
    } finally {
      await rm(broken, { recursive: true, force: true })
    }
  })

  it('treats a repo with no remote at all as a harmless no-op', async () => {
    // `git fetch` with nothing configured exits 0 having done nothing, so a
    // local-only repo reports success rather than surfacing a scary error.
    const local = await mkdtemp(join(tmpdir(), 'phosphor-local-'))
    try {
      await git(local, ['init', '-b', 'main'])
      expect(await fetchRepo(local)).toMatchObject({ fetched: true })
    } finally {
      await rm(local, { recursive: true, force: true })
    }
  })
})

describe('pullFastForward', () => {
  it('fast-forwards when the remote is ahead', async () => {
    await commit(origin, 'b.txt', 'two\n')
    await fetchRepo(repo, { force: true })

    const result = await pullFastForward(repo)
    expect(result).toMatchObject({ pulled: true, commits: 1 })
    expect(await git(repo, ['log', '--oneline', '--format=%s', '-1'])).toBe('add b.txt')
  })

  it('refuses to pull a diverged branch rather than making a merge commit', async () => {
    await commit(origin, 'b.txt', 'two\n')
    await commit(repo, 'c.txt', 'three\n')
    await fetchRepo(repo, { force: true })

    const result = await pullFastForward(repo)
    expect(result).toMatchObject({ pulled: false, reason: 'diverged', ahead: 1, behind: 1 })
    // The tree must be untouched — no merge, no conflict markers.
    expect(await git(repo, ['status', '--porcelain'])).toBe('')
  })

  it('refuses to pull over uncommitted changes', async () => {
    await commit(origin, 'b.txt', 'two\n')
    await fetchRepo(repo, { force: true })
    await writeFile(join(repo, 'a.txt'), 'dirty\n')

    expect(await pullFastForward(repo)).toMatchObject({
      pulled: false,
      reason: 'dirty',
      dirtyCount: 1,
    })
  })

  it('reports up-to-date without touching the tree', async () => {
    expect(await pullFastForward(repo)).toMatchObject({ pulled: false, reason: 'up-to-date' })
  })
})

describe('updateFromMain', () => {
  it('merges main into a worktree that has fallen behind', async () => {
    const worktree = await addWorktree(repo, 'task', { kind: 'new', base: 'HEAD' })
    await commit(repo, 'b.txt', 'two\n')

    const result = await updateFromMain(worktree.path, 'main')
    expect(result).toMatchObject({ updated: true, commits: 1 })
  })

  it('aborts on conflict rather than leaving the worktree mid-merge', async () => {
    const worktree = await addWorktree(repo, 'task', { kind: 'new', base: 'HEAD' })
    await commit(worktree.path, 'a.txt', 'worktree edit\n')
    await commit(repo, 'a.txt', 'main edit\n')

    const result = await updateFromMain(worktree.path, 'main')
    expect(result).toMatchObject({ updated: false, reason: 'conflict' })
    // The abort is the point: a half-merged worktree is unusable.
    expect(await git(worktree.path, ['status', '--porcelain'])).toBe('')
  })

  it('refuses when the worktree is dirty', async () => {
    const worktree = await addWorktree(repo, 'task', { kind: 'new', base: 'HEAD' })
    await commit(repo, 'b.txt', 'two\n')
    await writeFile(join(worktree.path, 'a.txt'), 'dirty\n')

    expect(await updateFromMain(worktree.path, 'main')).toMatchObject({
      updated: false,
      reason: 'dirty',
    })
  })

  it('is a no-op when already current', async () => {
    const worktree = await addWorktree(repo, 'task', { kind: 'new', base: 'HEAD' })
    expect(await updateFromMain(worktree.path, 'main')).toMatchObject({
      updated: false,
      reason: 'up-to-date',
    })
  })
})

describe('checkoutBranch', () => {
  it('checks out a branch in a clean tree', async () => {
    await git(repo, ['branch', 'feature'])

    expect(await checkoutBranch(repo, 'feature')).toMatchObject({
      checkedOut: true,
      branch: 'feature',
    })
    expect(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature')
  })

  it('refuses on a dirty tree so a menu pick can never discard work', async () => {
    await git(repo, ['branch', 'feature'])
    await writeFile(join(repo, 'a.txt'), 'dirty\n')

    expect(await checkoutBranch(repo, 'feature')).toMatchObject({
      checkedOut: false,
      reason: 'dirty',
      dirtyCount: 1,
    })
    expect(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
  })

  it('names the worktree already holding the branch instead of failing raw', async () => {
    const worktree = await addWorktree(repo, 'task', { kind: 'new', base: 'HEAD' })

    const result = await checkoutBranch(repo, 'task')
    expect(result).toMatchObject({ checkedOut: false, reason: 'held' })
    if (!result.checkedOut && result.reason === 'held') {
      expect(result.worktreePath).toBe(worktree.path)
    }
  })
})

describe('listBranches sync enrichment', () => {
  it('reports upstream and how far behind the remote a branch is', async () => {
    await commit(origin, 'b.txt', 'two\n')
    await fetchRepo(repo, { force: true })

    const { branches } = await listBranches(repo)
    const main = branches.find((b) => b.name === 'main')
    expect(main?.upstream).toBe('origin/main')
    expect(main?.behind).toBe(1)
    expect(main?.ahead).toBe(0)
  })

  it('reports how far a branch trails the default branch', async () => {
    await git(repo, ['branch', 'feature'])
    await commit(repo, 'b.txt', 'two\n')

    const { branches, defaultBranch } = await listBranches(repo)
    expect(defaultBranch).toBe('main')
    const feature = branches.find((b) => b.name === 'feature')
    // Undefined means "git too old for %(ahead-behind:)" — the UI treats that
    // as unknown, so only assert the number when the atom was supported.
    if (feature?.behindDefault !== undefined) expect(feature.behindDefault).toBe(1)
  })
})
