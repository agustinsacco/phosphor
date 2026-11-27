import { lstat, realpath, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isLaneBranchName } from '@phosphor/shared/host-protocol'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { dataResult, op } from '@phosphor/session-runtime/ops/results'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { checkedPath, FileFailure, laneRoot } from '../../features/files'
import { checkedOutBranch } from '../../lanes/runtime-host/branch'
import { WorkspaceLeased } from '../../owner/lease'
import type { DaemonHandlerDeps } from './index'
import {
  commitAll,
  mergeBranch,
  renameBranch,
} from '@phosphor/session-runtime/git/checkout-mutations'
import {
  checkoutBranch,
  fetchRepo,
  pullFastForward,
  updateFromMain,
} from '@phosphor/session-runtime/git/git-sync'
import { restoreFileTo } from '@phosphor/session-runtime/git/restore-file'
import { git, type GitRunner } from '@phosphor/session-runtime/git/git-exec'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { refusal, requireRuntime, targetLane } from './lane-target'

/** Bind Git to the owner's cwd and keep inherited Git settings from selecting another tree. */
export function ownerGit(signal?: AbortSignal): GitRunner {
  return (cwd, args, options) => {
    signal?.throwIfAborted()
    return git(
      cwd,
      [
        '--no-pager',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'submodule.recurse=false',
        '-c',
        'merge.autostash=false',
        '-c',
        'maintenance.auto=false',
        '-c',
        'protocol.ext.allow=never',
        ...(args[0] === 'merge' ? ['merge', '--no-overwrite-ignore', ...args.slice(1)] : args),
      ],
      {
        ...options,
        signal,
        isolateEnv: true,
        maxBuffer: options?.maxBuffer ?? 2 * 1024 * 1024,
        env: { ...options?.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
      },
    )
  }
}

export function gitRefusal(error: unknown): never {
  if (error instanceof OpRefusal) throw error
  if (error instanceof FileFailure) throw refusal(error.code)
  if (error instanceof WorkspaceLeased) throw new OpRefusal('busy', 'This checkout is reserved.')
  if (errnoIs(error, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) throw refusal('too-large')
  // Git can print a remote URL or arbitrary hook/remote output on failure.
  throw new OpRefusal(
    'bad-request',
    'Git refused. Check the checkout’s current status and references.',
  )
}

export async function verifyCheckout(cwd: string, run: GitRunner) {
  const top = await run(cwd, ['rev-parse', '--show-toplevel'], { trim: true })
  if ((await realpath(top)) !== cwd)
    throw new OpRefusal(
      'bad-request',
      'The lane must be at the root of its Git checkout for this operation.',
    )
}

export async function commonGitDir(cwd: string, run: GitRunner) {
  return realpath(
    await run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { trim: true }),
  )
}

export function branchName(branch: string) {
  if (!isLaneBranchName(branch)) throw new OpRefusal('bad-request', 'Name a valid branch.')
  return branch
}

interface Checkout {
  cwd: string
  run: GitRunner
}

function lockedCheckout<T>(
  deps: DaemonHandlerDeps,
  ctx: OpHandlerContext,
  work: (checkout: Checkout) => Promise<T>,
) {
  const { laneId } = targetLane(ctx)
  const runtime = requireRuntime(deps.laneRuntime)
  const lane = deps.store.getLane(laneId)
  if (!lane || lane.removedAt !== null) throw refusal('unknown-lane')
  const withPath = deps.editing.runtime.withSessionFile
  const run = ownerGit(ctx.signal)
  return laneRoot(deps, laneId)
    .then((cwd) =>
      withPath(cwd, async () => {
        const change = async () => {
          const current = deps.store.getLane(laneId)
          if (
            !current ||
            current.removedAt !== null ||
            current.sessionFile !== lane.sessionFile ||
            (await laneRoot(deps, laneId)) !== cwd
          )
            throw refusal('unknown-lane')
          await verifyCheckout(cwd, run)
          const repo = deps.store.listRepositories().find((row) => row.id === lane.repositoryId)
          if (!repo || (await commonGitDir(repo.path, run)) !== (await commonGitDir(cwd, run)))
            throw new OpRefusal(
              'bad-request',
              'The checkout no longer belongs to the lane’s repository.',
            )
          const siblings = deps.store
            .listLanes()
            .filter((row) => row.repositoryId === lane.repositoryId && resolve(row.cwd) === cwd)
          const summaries = [
            runtime.summaryFor(laneId),
            ...siblings.map((row) => runtime.summaryFor(row.laneId)),
          ]
          if (summaries.some((s) => s?.activity === 'working' || s?.activity === 'needs-input'))
            throw new OpRefusal(
              'busy',
              'Wait for the lane using this checkout to finish working or answer its prompt.',
            )
          ctx.signal?.throwIfAborted()
          try {
            return await work({ cwd, run })
          } finally {
            deps.lanes.lanesTopic.resourceChanged({
              kind: 'git',
              laneId,
              repositoryId: lane.repositoryId,
            })
          }
        }
        const locked = () => (lane.sessionFile ? withPath(lane.sessionFile, change) : change())
        return deps.workspaceLeases
          ? deps.workspaceLeases.withUse(cwd, 'live-lane', locked)
          : locked()
      }),
    )
    .catch(gitRefusal)
}

async function refreshBranch(deps: DaemonHandlerDeps, cwd: string) {
  const branch = await checkedOutBranch(cwd)
  if (!branch) return
  for (const lane of deps.store.listLanes()) {
    if (resolve(lane.cwd) !== cwd || lane.branch === branch) continue
    deps.store.updateLane(lane.laneId, { branch })
    deps.laneRuntime?.publishSummary(lane.laneId)
  }
}

function mutationResult(data: object) {
  if ('reason' in data && data.reason === 'conflict' && 'conflicts' in data) {
    const paths = (data.conflicts as string[]).slice(0, 20).map((file) => file.slice(0, 256))
    const total = (data.conflicts as string[]).length
    const result = dataResult({
      ...data,
      conflicts: paths,
      conflictCount: total,
      state: 'merge-in-progress',
    })
    return {
      ...result,
      text: paths.length
        ? `Checkout left in Git’s conflict state. Resolve the files and commit, or abort the merge. ${result.text}`
        : `Git left a merge in progress with no unmerged files. Inspect the status and commit, or abort the merge. ${result.text}`,
    }
  }
  return dataResult(data)
}

async function branchCommit(cwd: string, branch: string, run: GitRunner) {
  branchName(branch)
  for (const prefix of ['refs/heads/', 'refs/remotes/']) {
    const sha = await run(
      cwd,
      ['rev-parse', '--verify', '--end-of-options', `${prefix}${branch}^{commit}`],
      { allowFail: true, trim: true },
    )
    if (sha) return sha
  }
  throw new OpRefusal('bad-request', 'The named branch does not exist.')
}

async function fetchCheckout({ cwd, run }: Checkout, { force }: { force?: boolean }) {
  const branch = await checkedOutBranch(cwd)
  const configured =
    branch &&
    (await run(cwd, ['config', '--get', `branch.${branch}.remote`], {
      allowFail: true,
      trim: true,
    }))
  const remote = configured || 'origin'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote))
    throw new OpRefusal('bad-request', 'No supported upstream remote is configured.')
  const known = (await run(cwd, ['remote'])).split('\n').includes(remote)
  if (!known) throw new OpRefusal('bad-request', 'No fetch remote is configured.')
  const fetch = await fetchRepo(cwd, {
    force,
    run,
    args: [
      'fetch',
      '--prune',
      '--quiet',
      '--no-recurse-submodules',
      '--no-tags',
      '--no-prune-tags',
      '--refmap=',
      '--',
      remote,
      `+refs/heads/*:refs/remotes/${remote}/*`,
    ],
  })
  return fetch.fetched || fetch.reason === 'throttled'
    ? fetch
    : {
        fetched: false,
        reason: 'failed',
        message: 'Git could not fetch from the configured remote.',
      }
}

export function gitMutationHandlers(deps: DaemonHandlerDeps) {
  const change = <A>(handler: (checkout: Checkout, args: A) => Promise<object>) =>
    op<A>((args, ctx) =>
      lockedCheckout(deps, ctx, async (checkout) => mutationResult(await handler(checkout, args))),
    )
  return {
    'git.commitAll': change(({ cwd, run }, { message }: { message: string }) =>
      commitAll(cwd, message, run),
    ),
    'git.fetch': change(fetchCheckout),
    'git.pull': change(({ cwd, run }) => pullFastForward(cwd, run)),
    'git.checkout': change(async ({ cwd, run }, { branch }: { branch: string }) => {
      const result = await checkoutBranch(cwd, branchName(branch), { run, localOnly: true })
      if (result.checkedOut) await refreshBranch(deps, cwd)
      return result
    }),
    'git.renameBranch': change(async ({ cwd, run }, { from, to }: { from: string; to: string }) => {
      if ((await checkedOutBranch(cwd)) !== branchName(from))
        throw new OpRefusal(
          'bad-request',
          'Only the branch checked out in the target lane can be renamed.',
        )
      const result = await renameBranch(cwd, from, branchName(to), run)
      if (result.renamed) await refreshBranch(deps, cwd)
      return result
    }),
    'git.restoreFile': change(
      async ({ cwd, run }, { ref, path }: { ref: string; path: string }) => {
        const full = await checkedPath(cwd, path, true)
        const info = await lstat(full).catch((error: unknown) => {
          if (errnoIs(error, 'ENOENT')) return null
          throw error
        })
        if (info && !info.isFile())
          throw new OpRefusal('bad-request', 'Name a regular file inside the checkout.')
        return restoreFileTo(
          cwd,
          ref,
          path,
          async (file) => {
            if (info) await unlink(file)
          },
          run,
        )
      },
    ),
    'git.merge': change(async ({ cwd, run }, { branch }: { branch: string }) =>
      mergeBranch(cwd, await branchCommit(cwd, branch, run), { run, keepConflicts: true }),
    ),
    'git.updateFromMain': change(async ({ cwd, run }, { mainBranch }: { mainBranch: string }) =>
      updateFromMain(cwd, await branchCommit(cwd, mainBranch, run), { run, keepConflicts: true }),
    ),
  }
}
