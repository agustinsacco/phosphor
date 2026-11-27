import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createSessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { createWorkspaceLeases } from '../../owner/lease'
import { createGitFeature } from '../../features/git'
import { laneRefFor } from '../lane-ref'
import { domainHandlers, type DaemonHandlerDeps } from './index'

const afterPruneDryRun = vi.hoisted(() => vi.fn())
vi.mock('@phosphor/session-runtime/git/git-exec', async (original) => {
  const actual = await original<typeof import('@phosphor/session-runtime/git/git-exec')>()
  const git: typeof actual.git = async (cwd, args, options) => {
    const result = await actual.git(cwd, args, options)
    if (args.includes('prune') && args.includes('--dry-run')) afterPruneDryRun()
    return result
  }
  return { ...actual, git }
})

const temporary: string[] = []
afterEach(() => {
  afterPruneDryRun.mockReset()
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ops-git-')))
  temporary.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  const write = (name: string, content: string) => writeFileSync(join(root, name), content)
  write('a.txt', 'original\n')
  write('b.txt', 'original\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'initial')
  const laneId = 'd7d23aa6-f679-4be3-a799-7a59e16cb924'
  const repositoryId = '0123456789abcdef'
  const lane = {
    laneId,
    cwd: root,
    branch: 'main',
    repositoryId,
    removedAt: null,
    sessionFile: null,
  }
  const sibling = { ...lane, laneId: 'e0efa2f5-94c7-4a3a-944e-75f6e18d34d1' }
  const state = { activity: 'stopped', siblingActivity: 'stopped', occupant: '' }
  const changed = vi.fn()
  const store = {
    getLane: (id: string) => [lane, sibling].find((row) => row.laneId === id),
    listLanes: () => [lane, sibling],
    listRepositories: () => [{ id: repositoryId, path: root }],
    updateLane: (id: string, patch: Partial<typeof lane>) =>
      Object.assign(id === laneId ? lane : sibling, patch),
  }
  const feature = createGitFeature({ store, log: () => {} } as never)
  const paths = createSessionPathRuntime()
  const handlers = domainHandlers({
    store,
    lanes: { lanesTopic: { resourceChanged: changed }, calls: { call: feature.call } },
    laneRuntime: {
      summaryFor: (id: string) => ({
        ...store.getLane(id),
        activity: id === laneId ? state.activity : state.siblingActivity,
      }),
      publishSummary: vi.fn(),
    },
    editing: { runtime: { withSessionFile: paths.withSessionPath } },
    workspaceLeases: createWorkspaceLeases(() =>
      state.occupant ? [{ workspacePath: state.occupant }] : [],
    ),
  } as unknown as DaemonHandlerDeps)
  const run = (name: string, args = {}, request = {}) => {
    const handler = handlers[name]
    expect(handler, name).toBeTypeOf('function')
    return handler!(args, {
      lane: { ref: laneRefFor([], laneId) },
      ...request,
    } as OpHandlerContext)
  }
  const principal = {
    kind: 'agent',
    laneRef: laneRefFor([], laneId),
    sessionId: 'asking-session',
    lineage: 0,
    unattended: false,
  } as const
  return {
    root,
    write,
    run,
    state,
    changed,
    laneId,
    repositoryId,
    principal,
    siblingRef: laneRefFor([], sibling.laneId),
  }
}

it('pages branches, worktrees and diff chunks; diff path is literal and confined', async () => {
  const f = fixture()
  git(f.root, 'branch', 'topic')
  git(f.root, 'worktree', 'add', join(f.root, 'linked'), 'topic')
  for (const name of ['git.branches', 'git.worktrees']) {
    const first = await f.run(name, {}, { limit: 1 })
    expect(first.data).toHaveLength(1)
    expect(first.next).toBe('1')
    const next = await f.run(name, {}, { limit: 1, page: first.next })
    expect(next.data).toHaveLength(1)
    expect(next.next).toBeUndefined()
    expect(next.data).not.toEqual(first.data)
  }
  f.write('a.txt', `${'a'.repeat(60_000)}\n`)
  f.write('b.txt', 'other-file\n')
  const first = await f.run('git.diff', { path: 'a.txt' }, { limit: 100 })
  expect(first.next).toBeDefined()
  expect(Buffer.byteLength(JSON.stringify(first.data))).toBeLessThanOrEqual(12 * 1024)
  let cursor = first.next
  let diff = (first.data as { chunk: string }[]).map((row) => row.chunk).join('')
  while (cursor) {
    const result = await f.run('git.diff', { path: 'a.txt' }, { page: cursor })
    cursor = result.next
    diff += (result.data as { chunk: string }[]).map((row) => row.chunk).join('')
  }
  expect(diff).toContain('a'.repeat(60_000))
  expect(diff).not.toContain('b.txt')
  await expect(f.run('git.diff', { path: '../outside' })).rejects.toMatchObject({
    code: 'bad-request',
  })
})

it('commits, checks out and merges without touching other checkouts; invalidates the UI', async () => {
  const f = fixture()
  git(f.root, 'branch', 'topic')
  expect(await f.run('git.checkout', { branch: 'topic' })).toMatchObject({
    data: { checkedOut: true },
  })
  f.write('a.txt', 'new\n')
  expect(await f.run('git.commitAll', { message: 'checkpoint' })).toMatchObject({
    data: { sha: expect.any(String) },
  })
  await f.run('git.checkout', { branch: 'main' })
  expect(await f.run('git.merge', { branch: 'topic' })).toMatchObject({ data: { merged: true } })
  expect(git(f.root, 'show', 'HEAD:a.txt')).toBe('new')
  expect(f.changed).toHaveBeenCalledWith({
    kind: 'git',
    laneId: f.laneId,
    repositoryId: f.repositoryId,
  })
})

it.each(['git.merge', 'git.updateFromMain'])(
  '%s reports conflicts and keeps Git’s conflict state',
  async (name) => {
    const f = fixture()
    git(f.root, 'checkout', '-b', 'side')
    f.write('a.txt', 'side\n')
    git(f.root, 'commit', '-am', 'side')
    git(f.root, 'checkout', 'main')
    f.write('a.txt', 'main\n')
    git(f.root, 'commit', '-am', 'main')
    expect(await f.run(name, { branch: 'side', mainBranch: 'side' })).toMatchObject({
      text: expect.stringContaining('left in Git’s conflict state'),
      data: { reason: 'conflict', conflicts: ['a.txt'] },
    })
    expect(git(f.root, 'rev-parse', '--verify', 'MERGE_HEAD')).toBe(
      git(f.root, 'rev-parse', 'side'),
    )
  },
)

it.each(['working', 'needs-input'])('refuses changes when the target is %s', async (activity) => {
  const f = fixture()
  f.state.activity = activity
  await expect(f.run('git.commitAll', { message: 'must not run' })).rejects.toMatchObject({
    code: 'busy',
  })
  expect(f.changed).not.toHaveBeenCalled()
})

it.each(['self', 'idle sibling'])('allows a working agent to write on %s', async (target) => {
  const f = fixture()
  f.state.activity = 'working'
  f.write('a.txt', 'agent change\n')
  const request = {
    principal: f.principal,
    ...(target === 'idle sibling' ? { lane: { ref: f.siblingRef } } : {}),
  }
  await expect(
    f.run('git.commitAll', { message: 'agent checkpoint' }, request),
  ).resolves.toMatchObject({
    data: { sha: expect.any(String) },
  })
  expect(git(f.root, 'show', 'HEAD:a.txt')).toBe('agent change')
})

it.each(['working', 'needs-input'])(
  'refuses an agent write when its sibling is %s',
  async (activity) => {
    const f = fixture()
    f.state.activity = 'working'
    f.state.siblingActivity = activity
    for (const ref of [f.principal.laneRef, f.siblingRef]) {
      await expect(
        f.run(
          'git.commitAll',
          { message: 'must not run' },
          {
            principal: f.principal,
            lane: { ref },
          },
        ),
      ).rejects.toMatchObject({ code: 'busy' })
    }
    expect(f.changed).not.toHaveBeenCalled()
  },
)

it('refuses restore through traversal or a parent symlink', async () => {
  const f = fixture()
  symlinkSync(tmpdir(), join(f.root, 'outside'))
  for (const path of ['../outside', 'outside/file']) {
    await expect(f.run('git.restoreFile', { ref: 'HEAD', path })).rejects.toMatchObject({
      code: 'bad-request',
    })
  }
})

it('fetches from a local bare remote and fast-forwards to the fetched tip', async () => {
  const f = fixture()
  git(f.root, 'clone', '.', 'writer')
  const writer = join(f.root, 'writer')
  git(writer, 'config', 'user.email', 'test@example.com')
  git(writer, 'config', 'user.name', 'Test')
  writeFileSync(join(writer, 'a.txt'), 'remote\n')
  git(writer, 'commit', '-am', 'remote')
  git(f.root, 'clone', '--bare', 'writer', 'remote.git')
  git(f.root, 'remote', 'add', 'origin', join(f.root, 'remote.git'))
  const ignore = join(f.root, '.git', 'info', 'exclude')
  writeFileSync(ignore, '/remote.git/\n/writer/\n')
  expect(await f.run('git.fetch', { force: true })).toMatchObject({ data: { fetched: true } })
  git(f.root, 'branch', '-u', 'origin/main')
  expect(await f.run('git.pull')).toMatchObject({ data: { pulled: true } })
  expect(git(f.root, 'show', 'HEAD:a.txt')).toBe('remote')
})

it('refuses to remove a linked worktree held by a live lane', async () => {
  const f = fixture()
  const path = join(f.root, '.phosphor', 'worktrees', 'topic')
  git(f.root, 'worktree', 'add', '-b', 'topic', path)
  f.state.occupant = path
  await expect(f.run('worktree.remove', { path, force: true })).rejects.toMatchObject({
    code: 'busy',
  })
  expect(git(path, 'branch', '--show-current')).toBe('topic')
})

it('adds, removes, restores and recreates a managed worktree on the named branch', async () => {
  const f = fixture()
  const path = join(f.root, '.phosphor', 'worktrees', 'folder')
  const args = { repo: f.root, name: 'folder', branch: 'topic' }
  expect(await f.run('worktree.add', args)).toMatchObject({ data: { path, branch: 'topic' } })
  await f.run('worktree.remove', { path })
  await f.run('worktree.restore', args)
  expect(git(path, 'branch', '--show-current')).toBe('topic')
  await f.run('worktree.remove', { path })
  git(f.root, 'branch', '-d', 'topic')
  await f.run('worktree.recreate', args)
  expect(git(path, 'branch', '--show-current')).toBe('topic')
})

it('prunes only the named registration, refusing while another would be affected', async () => {
  const f = fixture()
  const parent = join(f.root, '.phosphor', 'worktrees')
  for (const name of ['one', 'two']) {
    const path = join(parent, name)
    git(f.root, 'worktree', 'add', '-b', name, path)
    rmSync(path, { recursive: true })
  }
  await expect(f.run('worktree.prune', { path: join(parent, 'one') })).rejects.toThrow('two')
  expect(git(f.root, 'worktree', 'list', '--porcelain')).toContain(join(parent, 'one'))
  git(f.root, 'worktree', 'lock', join(parent, 'two'))
  await f.run('worktree.prune', { path: join(parent, 'one') })
  expect(git(f.root, 'worktree', 'list', '--porcelain')).not.toContain(join(parent, 'one'))
  expect(git(f.root, 'worktree', 'list', '--porcelain')).toContain(join(parent, 'two'))
})

it('leaves a sibling registration that becomes stale after the prune dry run', async () => {
  const f = fixture()
  const parent = join(f.root, '.phosphor', 'worktrees')
  const path = join(parent, 'one')
  const sibling = join(parent, 'two')
  git(f.root, 'worktree', 'add', '-b', 'one', path)
  git(f.root, 'worktree', 'add', '-b', 'two', sibling)
  rmSync(path, { recursive: true })
  afterPruneDryRun.mockImplementationOnce(() => rmSync(sibling, { recursive: true }))

  expect(await f.run('worktree.prune', { path })).toMatchObject({ data: { pruned: [path] } })
  expect(afterPruneDryRun).toHaveBeenCalledOnce()
  const registrations = git(f.root, 'worktree', 'list', '--porcelain')
  expect(registrations).not.toContain(path)
  expect(registrations).toContain(sibling)
})

it.each(['locked', 'gitdir', 'restored path'])(
  'refuses to prune when the %s changes after the dry run',
  async (change) => {
    const f = fixture()
    const path = join(f.root, '.phosphor', 'worktrees', 'one')
    const admin = join(f.root, '.git', 'worktrees', 'one')
    git(f.root, 'worktree', 'add', '-b', 'one', path)
    rmSync(path, { recursive: true })
    afterPruneDryRun.mockImplementationOnce(() => {
      if (change === 'locked') git(f.root, 'worktree', 'lock', path)
      else if (change === 'gitdir') writeFileSync(join(admin, 'gitdir'), `${path}-other/.git\n`)
      else symlinkSync(admin, path)
    })

    await expect(f.run('worktree.prune', { path })).rejects.toMatchObject({ code: 'bad-request' })
    expect(afterPruneDryRun).toHaveBeenCalledOnce()
    expect(existsSync(admin)).toBe(true)
  },
)
