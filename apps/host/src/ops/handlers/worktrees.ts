import { constants } from 'node:fs'
import { lstat, open, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { dataResult, op } from '@phosphor/session-runtime/ops/results'
import { refExists, startPoint } from '@phosphor/session-runtime/git/branches'
import {
  addGitWorktree,
  directory,
  excludeWorktrees,
  removeGitWorktree,
  worktreeRootFor,
} from '@phosphor/session-runtime/git/managed-worktree'
import { listWorktreeMetadata } from '@phosphor/session-runtime/git/worktree-metadata'
import { dirtyCount, type GitRunner } from '@phosphor/session-runtime/git/git-exec'
import { gitInfoCache } from '@phosphor/session-runtime/git/git-info-cache'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import type { RepositorySummary } from '@phosphor/shared/host-protocol'
import { deleteLandedBranch } from '../../lanes/delete'
import { canonicalRemovedPath } from '../../machine/repositories'
import { branchName, commonGitDir, gitRefusal, ownerGit, verifyCheckout } from './git-checkout'
import type { DaemonHandlerDeps } from './index'

const OWNER = 'worktree-ops'
const validName = (name: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.includes('..')
const bad = (message: string) => new OpRefusal('bad-request', message)
const stat = (path: string) =>
  lstat(path).catch((error: unknown) => {
    if (errnoIs(error, 'ENOENT')) return null
    throw error
  })

interface Target {
  repo: RepositorySummary
  root: string
  path: string
  run: GitRunner
}

async function target(
  deps: DaemonHandlerDeps,
  ctx: OpHandlerContext,
  repoPath: string,
  name: string,
): Promise<Target> {
  if (!isAbsolute(repoPath) || !validName(name))
    throw bad('Name a configured repository and a managed worktree folder.')
  const root = await realpath(repoPath)
  const repo = deps.store.listRepositories().find((row) => resolve(row.path) === root)
  if (!repo) throw bad('Choose a configured repository on this Host.')
  const path = join(worktreeRootFor(root), name)
  return { root, repo, path, run: ownerGit(ctx.signal) }
}

function pathTarget(deps: DaemonHandlerDeps, ctx: OpHandlerContext, path: string) {
  const repoPath = dirname(dirname(dirname(path)))
  if (path !== join(worktreeRootFor(repoPath), basename(path)))
    throw bad('Use the exact absolute path of a managed worktree.')
  return target(deps, ctx, repoPath, basename(path)).then((info) => {
    if (info.path !== path) throw bad('Use the exact canonical worktree path.')
    return info
  })
}

async function reserved<T>(
  deps: DaemonHandlerDeps,
  ctx: OpHandlerContext,
  t: Target,
  work: (allowed: () => boolean) => Promise<T>,
) {
  const { workspaceLeases: leases } = deps
  if (!leases) throw new OpRefusal('unavailable', 'Worktree leases are unavailable.')
  return deps.editing.runtime.withSessionFile(t.root, async () => {
    const allowed = () => !ctx.signal?.aborted
    if (!allowed()) throw bad('The request was cancelled.')
    await verifyCheckout(t.root, t.run)
    if ((await canonicalRemovedPath(t.path)) !== t.path)
      throw bad('The worktree path must not be a symbolic link.')
    for (const folder of [dirname(dirname(t.path)), dirname(t.path), t.path]) {
      const info = await stat(folder)
      if (info && !info.isDirectory()) throw bad('A worktree path component is not a directory.')
    }
    const held = await leases.take(OWNER, [t.path], Infinity)
    if (!('leaseId' in held))
      throw new OpRefusal('busy', 'This worktree is reserved or in use by a live lane or routine.')
    try {
      return await deps.editing.runtime.withSessionFile(t.path, () => work(allowed))
    } finally {
      leases.release(OWNER, held.leaseId)
      deps.lanes.lanesTopic.resourceChanged({ kind: 'git', repositoryId: t.repo.id })
    }
  })
}

async function pointsToCheckout(admin: string, path: string) {
  const file = await open(
    join(admin, 'gitdir'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 64 * 1024) return false
    const pointer = (await file.readFile('utf8')).replace(/\r?\n$/, '')
    const gitdir = join(path, '.git')
    return pointer === gitdir || pointer === relative(admin, gitdir)
  } finally {
    await file.close()
  }
}

async function prune(t: Target, allowed: () => boolean) {
  const { root, path, run } = t
  const stale = (await listWorktreeMetadata(root, run)).filter((w) => w.prunable && !w.locked)
  if (!stale.some((w) => w.path === path))
    throw bad('The named worktree does not have a prunable registration.')
  const others = stale.filter((w) => w.path !== path)
  if (others.length) {
    const shown = others
      .slice(0, 8)
      .map((w) => JSON.stringify(w.path.slice(0, 256)))
      .join(', ')
    throw bad(
      `Prune would also affect ${shown}${others.length > 8 ? ' and more' : ''}; no registrations were pruned.`,
    )
  }
  let diagnostics = ''
  await run(root, ['worktree', 'prune', '--expire=now', '--dry-run', '--verbose'], {
    env: { LC_ALL: 'C' },
    stderr: (out) => {
      diagnostics = out
    },
  })
  // Git can also prune broken metadata not appearing in `worktree list`.
  const name = /^Removing worktrees\/([^/\\:\r\n\0]+): [^\r\n]+$/.exec(diagnostics.trimEnd())?.[1]
  if (!name || name === '.' || name === '..')
    throw bad('Git cannot prove the named registration is the only prune target.')
  const worktrees = join(await commonGitDir(root, run), 'worktrees')
  const admin = join(worktrees, name)
  if (
    (await realpath(dirname(admin))) !== worktrees ||
    !(await stat(admin))?.isDirectory() ||
    !(await pointsToCheckout(admin, path)) ||
    (await stat(path)) ||
    (await stat(join(admin, 'locked')))
  )
    throw bad('The worktree registration changed or is protected; nothing was pruned.')
  if (!allowed()) throw bad('The request was cancelled.')
  // Do not ask Git to prune again: another checkout could now be stale.
  try {
    await rm(admin, { recursive: true })
  } finally {
    gitInfoCache.invalidate()
  }
  return { pruned: [path] }
}

type Create = { repo: string; name: string; branch: string }
async function create(
  deps: DaemonHandlerDeps,
  t: Target,
  mode: 'add' | 'restore' | 'recreate',
  name: string,
  allowed: () => boolean,
) {
  const { root, path, run } = t
  const branch = branchName(name)
  if (await stat(path)) throw bad('The worktree folder already exists.')
  const holders = deps.store.listLanes().filter((lane) => lane.cwd === path)
  if (holders.some((lane) => lane.branch !== branch || lane.repositoryId !== t.repo.id))
    throw bad('A lane records a different branch at this worktree path.')
  const trees = await listWorktreeMetadata(root, run)
  const registered = trees.find((tree) => tree.path === path)
  if (
    registered &&
    (mode === 'add' || registered.branch !== branch || !registered.prunable || registered.locked)
  )
    throw bad('The path already has a different or protected worktree registration.')
  if (trees.some((tree) => tree.path !== path && tree.branch === branch))
    throw bad('That branch is already checked out in another worktree.')
  const existing = await refExists(root, `refs/heads/${branch}`, run)
  if (!existing && mode === 'restore')
    throw bad(
      'The original branch no longer exists; use worktree.recreate to start from the default branch.',
    )
  const trunk = await startPoint(root, run)
  if (trunk.defaultBranch === branch) throw bad('The default branch belongs in the main checkout.')
  if (registered) await prune(t, allowed)
  directory(dirname(dirname(path)))
  directory(dirname(path))
  const common = await run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    trim: true,
  })
  if (common !== join(root, '.git') || (await realpath(common)) !== common)
    throw bad('Worktree creation needs the repository’s own Git directory.')
  directory(join(common, 'info'))
  excludeWorktrees(join(common, 'info', 'exclude'))
  const base = await run(
    root,
    ['rev-parse', '--verify', '--end-of-options', `${trunk.base}^{commit}`],
    { trim: true },
  )
  await addGitWorktree(
    root,
    path,
    existing ? { kind: 'existing', branch } : { kind: 'new', branch, base, noTrack: true },
    run,
  )
  return { path, branch }
}

export function worktreeHandlers(deps: DaemonHandlerDeps) {
  const createHandler = (mode: 'add' | 'restore' | 'recreate') =>
    op<Create>(async (args, ctx) => {
      const t = await target(deps, ctx, args.repo, args.name).catch(gitRefusal)
      return dataResult(
        await reserved(deps, ctx, t, (allowed) =>
          create(deps, t, mode, args.branch, allowed),
        ).catch(gitRefusal),
      )
    })
  return {
    'worktree.add': createHandler('add'),
    'worktree.restore': createHandler('restore'),
    'worktree.recreate': createHandler('recreate'),
    'worktree.prune': op<{ path: string }>(async ({ path }, ctx) => {
      const t = await pathTarget(deps, ctx, path).catch(gitRefusal)
      return dataResult(
        await reserved(deps, ctx, t, (allowed) => prune(t, allowed)).catch(gitRefusal),
      )
    }),
    'worktree.remove': op<{ path: string; force?: boolean; deleteBranch?: boolean }>(
      async ({ path, force, deleteBranch }, ctx) => {
        const t = await pathTarget(deps, ctx, path).catch(gitRefusal)
        return dataResult(
          await reserved(deps, ctx, t, async (allowed) => {
            const tree = (await listWorktreeMetadata(t.root, t.run)).find(
              (row) => row.path === path,
            )
            if (!tree || tree.isMain || tree.locked || tree.prunable || tree.realPath !== path)
              throw bad(
                'The named worktree is missing, locked, or not a linked checkout of this repository.',
              )
            const holders = deps.store.listLanes().filter((lane) => lane.cwd === path)
            if (
              holders.some((lane) => lane.branch !== tree.branch || lane.repositoryId !== t.repo.id)
            )
              throw bad('A lane records a different checkout identity at this path.')
            await verifyCheckout(path, t.run)
            if ((await commonGitDir(path, t.run)) !== (await commonGitDir(t.root, t.run)))
              throw bad('This folder no longer belongs to the repository.')
            const current = await t.run(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
              allowFail: true,
              trim: true,
            })
            if ((current || null) !== tree.branch)
              throw bad('The worktree branch changed; read it again first.')
            if (!force) {
              const count = await dirtyCount(path, t.run)
              if (count) return { removed: false, dirtyCount: count }
            }
            await removeGitWorktree(t.root, path, force === true, t.run)
            const branchDeleted =
              deleteBranch === true &&
              tree.branch !== null &&
              holders.length === 0 &&
              (await deleteLandedBranch(t.root, tree.branch, allowed))
            return { removed: true, branchDeleted }
          }).catch(gitRefusal),
        )
      },
    ),
  }
}
