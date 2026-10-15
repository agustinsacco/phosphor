import * as gitExec from '@phosphor/session-runtime/git/git-exec'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { createLaneDeletion, deleteMergedBranch, branchMerged, transcriptTrash } from './delete'
import { openStore, type HostStore } from './store'
vi.mock('@phosphor/session-runtime/git/git-exec', { spy: true })
let root: string, store: HostStore
const run = (args: string[]) => git(root, args, { isolateEnv: true, trim: true })
beforeEach(async () => {
  vi.mocked(gitExec.git).mockReset()
  root = await mkdtemp(join(tmpdir(), 'host-delete-'))
  store = await openStore(join(root, 'state'), process.getuid?.())
  await run(['init', '-b', 'main'])
  await run(['config', 'user.name', 'Test'])
  await run(['config', 'user.email', 'test@example.invalid'])
  await writeFile(join(root, 'a'), 'initial')
  await run(['add', 'a'])
  await run(['commit', '-m', 'initial'])
})
afterEach(async () => {
  vi.restoreAllMocks()
  store.close()
  await rm(root, { recursive: true, force: true })
})
it('keeps unmerged, current and checked-out branches; removes a squash-proven branch', async () => {
  await run(['checkout', '-b', 'feature'])
  await writeFile(join(root, 'a'), 'feature')
  await run(['commit', '-am', 'feature'])
  vi.mocked(gitExec.git).mockClear()
  expect(await deleteMergedBranch(root, 'feature')).toBe(false)
  expect(vi.mocked(gitExec.git).mock.calls.some((c) => c[1][0] === 'branch')).toBe(false)
  await run(['checkout', 'main'])
  expect(await branchMerged(root, 'feature')).toBe(false)
  expect(await deleteMergedBranch(root, 'feature')).toBe(false)
  await run(['merge', '--squash', 'feature'])
  await run(['commit', '-m', 'squashed'])
  expect(await branchMerged(root, 'feature')).toBe(true)
  await run(['worktree', 'add', join(root, 'wt'), 'feature'])
  vi.mocked(gitExec.git).mockClear()
  expect(await deleteMergedBranch(root, 'feature')).toBe(false)
  expect(vi.mocked(gitExec.git).mock.calls.some((c) => c[1][0] === 'branch')).toBe(false)
  await run(['worktree', 'remove', join(root, 'wt')])
  let checks = 0
  expect(await deleteMergedBranch(root, 'feature', () => ++checks === 1)).toBe(false)
  expect(checks).toBe(2)
  expect(await run(['rev-parse', '--verify', 'feature'])).toMatch(/^[a-f0-9]{40}$/)
  expect(await deleteMergedBranch(root, 'feature')).toBe(true)
  await expect(run(['show-ref', '--verify', 'refs/heads/feature'])).rejects.toThrow()
  expect(await deleteMergedBranch(root, 'main')).toBe(false)
})
it('stops before trashing, marks removed and publishes, but refuses lost admission', async () => {
  const repo = store.syncRepositories([root])[0]
  if (!repo) throw new Error('fixture')
  const lane = store.ensureLane({ repositoryId: repo.id, cwd: root, sessionFile: null })
  const stop = vi.fn(async () => {}),
    remove = vi.fn(async () => {}),
    forget = vi.fn()
  const deletion = createLaneDeletion({ store, stop, remove, forget })
  const op = {
    type: 'lane.delete' as const,
    laneId: lane.laneId,
    removeWorktree: false,
    removeBranch: false,
  }
  expect(await deletion(op, () => false)).toEqual({ ok: false, code: 'forbidden' })
  expect(stop).not.toHaveBeenCalled()
  expect(await deletion(op, () => true)).toEqual({ ok: true, data: { branchKept: false } })
  expect(store.getLane(lane.laneId)?.removedAt).not.toBeNull()
  expect(forget).toHaveBeenCalledWith(lane.laneId)
})
it('moves transcripts to Host trash and sweeps only old matching files', async () => {
  const trash = transcriptTrash(root)
  await writeFile(join(root, 'file.jsonl'), 'transcript')
  await trash.move(join(root, 'file.jsonl'))
  await writeFile(
    join(root, 'trash', '1000000000000-12345678-1234-4234-8234-123456789abc.jsonl'),
    'old',
  )
  await writeFile(join(root, 'trash', 'unrelated'), 'keep')
  await trash.sweep()
  expect(await readFile(join(root, 'trash', 'unrelated'), 'utf8')).toBe('keep')
})

it('never stops or removes a shared worktree', async () => {
  const repo = store.syncRepositories([root])[0]
  if (!repo) throw new Error('fixture')
  const cwd = join(root, '.phosphor', 'worktrees', 'shared')
  await mkdir(cwd, { recursive: true })
  const lane = store.ensureLane({ repositoryId: repo.id, cwd, sessionFile: null, worktree: true })
  store.ensureLane({ repositoryId: repo.id, cwd, sessionFile: null, worktree: true })
  const stop = vi.fn(async () => {}),
    remove = vi.fn(async () => {}),
    forget = vi.fn()
  expect(
    await createLaneDeletion({ store, stop, remove, forget })(
      { type: 'lane.delete', laneId: lane.laneId, removeWorktree: true, removeBranch: true },
      () => true,
    ),
  ).toEqual({ ok: false, code: 'busy' })
  expect(stop).not.toHaveBeenCalled()
})

it.each([true, false])(
  'reports branchKept=%s without failing lane deletion',
  async (branchKept) => {
    await run(['branch', 'feature'])
    if (branchKept) {
      await run(['checkout', 'feature'])
      await writeFile(join(root, 'a'), 'unmerged')
      await run(['commit', '-am', 'unmerged'])
      await run(['checkout', 'main'])
    }
    const repo = store.syncRepositories([root])[0]
    if (!repo) throw new Error('fixture')
    const cwd = join(root, '.phosphor', 'worktrees', 'feature')
    await mkdir(cwd, { recursive: true })
    const lane = store.ensureLane({
      repositoryId: repo.id,
      cwd,
      sessionFile: null,
      worktree: true,
      branch: 'feature',
    })
    const deletion = createLaneDeletion({
      store,
      stop: async () => {},
      remove: async () => {},
      forget: () => {},
    })
    expect(
      await deletion(
        { type: 'lane.delete', laneId: lane.laneId, removeWorktree: false, removeBranch: true },
        () => true,
      ),
    ).toEqual({ ok: true, data: { branchKept } })
    expect(store.getLane(lane.laneId)?.removedAt).not.toBeNull()
  },
)

it('rechecks authority before a normally merged branch deletion', async () => {
  await run(['branch', 'feature'])
  expect(await deleteMergedBranch(root, 'feature', () => false)).toBe(false)
  expect(await run(['rev-parse', '--verify', 'feature'])).toMatch(/^[a-f0-9]{40}$/)
})

it('keeps a concurrently advanced branch by comparing the proven object id atomically', async () => {
  await run(['checkout', '-b', 'feature'])
  await writeFile(join(root, 'a'), 'feature')
  await run(['commit', '-am', 'feature'])
  await run(['checkout', 'main'])
  await run(['merge', '--squash', 'feature'])
  await run(['commit', '-m', 'squashed'])
  const advanced = await run(['rev-parse', 'main'])
  const actual = (await vi.importActual<typeof gitExec>('@phosphor/session-runtime/git/git-exec'))
    .git
  vi.mocked(gitExec.git).mockImplementation(async (cwd, args, options) => {
    if (
      (args[0] === 'update-ref' && args.includes('-d')) ||
      (args[0] === 'branch' && args[1] === '-D')
    )
      await actual(root, ['update-ref', 'refs/heads/feature', advanced], { isolateEnv: true })
    return actual(cwd, args, options)
  })
  const repo = store.syncRepositories([root])[0]!
  const cwd = join(root, '.phosphor', 'worktrees', 'feature')
  await mkdir(cwd, { recursive: true })
  const lane = store.ensureLane({
    repositoryId: repo.id,
    cwd,
    sessionFile: null,
    branch: 'feature',
    worktree: true,
  })
  const deletion = createLaneDeletion({
    store,
    stop: async () => {},
    remove: async () => {},
    forget: () => {},
  })
  expect(
    await deletion(
      { type: 'lane.delete', laneId: lane.laneId, removeWorktree: false, removeBranch: true },
      () => true,
    ),
  ).toEqual({ ok: true, data: { branchKept: true } })
  expect(await run(['rev-parse', 'feature'])).toBe(advanced)
})

async function deleteFeatureLane() {
  const repo = store.syncRepositories([root])[0]!
  const cwd = join(root, '.phosphor', 'worktrees', 'feature')
  await mkdir(cwd, { recursive: true })
  const lane = store.ensureLane({
    repositoryId: repo.id,
    cwd,
    sessionFile: null,
    branch: 'feature',
    worktree: true,
  })
  return createLaneDeletion({
    store,
    stop: async () => {},
    remove: async () => {},
    forget: () => {},
  })(
    { type: 'lane.delete', laneId: lane.laneId, removeWorktree: false, removeBranch: true },
    () => true,
  )
}

it('keeps symbolic branch refs pointing at checked-out main without deleting main', async () => {
  const tip = await run(['rev-parse', 'main'])
  await run(['symbolic-ref', 'refs/heads/feature', 'refs/heads/main'])
  expect(await deleteFeatureLane()).toEqual({ ok: true, data: { branchKept: true } })
  expect(await run(['rev-parse', '--verify', 'refs/heads/main'])).toBe(tip)
  expect(await run(['symbolic-ref', '-q', 'refs/heads/feature'])).toBe('refs/heads/main')
})

it('restores the proven tip when another worktree checks out the branch just before mutation', async () => {
  await run(['checkout', '-b', 'feature'])
  await writeFile(join(root, 'a'), 'feature')
  await run(['commit', '-am', 'feature'])
  const tip = await run(['rev-parse', 'feature'])
  await run(['checkout', 'main'])
  await run(['merge', '--squash', 'feature'])
  await run(['commit', '-m', 'squashed'])
  const actual = (await vi.importActual<typeof gitExec>('@phosphor/session-runtime/git/git-exec'))
    .git
  let injected = false
  vi.mocked(gitExec.git).mockImplementation(async (cwd, args, options) => {
    if (args[0] === 'update-ref' && args.includes('-d')) {
      injected = true
      await actual(root, ['worktree', 'add', join(root, 'racing-worktree'), 'feature'], {
        isolateEnv: true,
      })
    }
    return actual(cwd, args, options)
  })
  expect(await deleteFeatureLane()).toEqual({ ok: true, data: { branchKept: true } })
  expect(injected).toBe(true)
  expect(await run(['rev-parse', '--verify', 'refs/heads/feature'])).toBe(tip)
  expect(await run(['-C', join(root, 'racing-worktree'), 'symbolic-ref', 'HEAD'])).toBe(
    'refs/heads/feature',
  )
  expect(await run(['-C', join(root, 'racing-worktree'), 'rev-parse', 'HEAD'])).toBe(tip)
})

it('retries after trash succeeds and dirty worktree removal fails, including an already removed worktree', async () => {
  const repo = store.syncRepositories([root])[0]!
  const cwd = join(root, '.phosphor', 'worktrees', 'feature')
  await mkdir(join(root, '.phosphor', 'worktrees'), { recursive: true })
  await run(['worktree', 'add', '-b', 'feature', cwd])
  const file = join(root, 'session.jsonl')
  await writeFile(file, 'transcript')
  const lane = store.ensureLane({
    repositoryId: repo.id,
    cwd,
    sessionFile: file,
    branch: 'feature',
    worktree: true,
  })
  await writeFile(join(cwd, 'a'), 'dirty')
  const trash = transcriptTrash(root)
  const remove = vi.fn(async () => {
    await trash.move(file)
  })
  const op = {
    type: 'lane.delete' as const,
    laneId: lane.laneId,
    removeWorktree: true,
    removeBranch: true,
  }
  const options = { store, stop: async () => {}, remove, forget: () => {} }
  expect((await createLaneDeletion(options)(op, () => true)).ok).toBe(false)
  await expect(readFile(file)).rejects.toThrow()
  await run(['-C', cwd, 'checkout', '--', 'a'])
  // Recreating the deletion service proves retries do not depend on in-memory progress.
  expect(await createLaneDeletion(options)(op, () => true)).toEqual({
    ok: true,
    data: { branchKept: false },
  })
  expect(remove).toHaveBeenCalledTimes(1)
})

it('finishes when the worktree was already removed by an interrupted attempt', async () => {
  const repo = store.syncRepositories([root])[0]!
  const cwd = join(root, '.phosphor', 'worktrees', 'gone')
  const lane = store.ensureLane({ repositoryId: repo.id, cwd, sessionFile: null, worktree: true })
  expect(
    await createLaneDeletion({
      store,
      stop: async () => {},
      remove: async () => {},
      forget: () => {},
    })(
      { type: 'lane.delete', laneId: lane.laneId, removeWorktree: true, removeBranch: false },
      () => true,
    ),
  ).toEqual({ ok: true, data: { branchKept: false } })
})
