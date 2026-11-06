import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { slugifyTitle } from '@phosphor/shared/branchName'
import { isLaneBranchName } from '@phosphor/shared/host-protocol'
import type {
  LaneSourceFacts,
  LaneTargetPlan,
} from '@phosphor/shared/host-protocol-lane-transfer'
import { resolveDefaultBranch } from '../git/default-branch'
import { git } from '../git/git-exec'
import { gitTracking } from '../git/git-tracking'
import { refuse } from './files'
import { NETWORK_GIT_ENV, NETWORK_TIMEOUT_MS, repositoryOrigin } from './source-git'

export type TargetGit =
  | { kind: 'folder' }
  | { kind: 'unreadable' }
  | { kind: 'git'; top: string; origin: string | null; trunk: string | null }

/** What the target workspace is, read without changing it. */
export async function inspectTargetGit(root: string): Promise<TargetGit> {
  const tracking = await gitTracking(root)
  if (tracking === false) return { kind: 'folder' }
  if (tracking === null) return { kind: 'unreadable' }
  const run = (args: string[]) => git(root, args, { trim: true, env: { LC_ALL: 'C' } })
  const top = await run(['rev-parse', '--show-toplevel']).catch(() => '')
  if (!top) return { kind: 'unreadable' }
  return {
    kind: 'git',
    top: await realpath(top),
    origin: await repositoryOrigin(root),
    trunk: await resolveDefaultBranch(run).catch(() => null),
  }
}

export interface PlanInput {
  source: LaneSourceFacts
  target: TargetGit
  /** The target workspace's own path, resolved. */
  root: string
  workspace: string
  branchPrefix: string
  /** Source and target are one machine, so the source's paths name real folders here. */
  sameMachine: boolean
}

/**
 * Decide how a lane lands, and every reason it cannot. Pure: the facts were
 * read already, and everything here is checked again when the move commits.
 */
export function planMove(input: PlanInput): LaneTargetPlan {
  const { source, target, workspace } = input
  const blockers: string[] = []
  const git = source.git
  if (git?.dirty)
    blockers.push('This lane has uncommitted changes. Commit or discard them, then move it.')
  if (target.kind === 'unreadable') {
    blockers.push('Git could not read the target workspace.')
    return { mode: 'folder', branch: null, workspace, blockers }
  }
  if (target.kind === 'folder') {
    if (input.sameMachine && source.cwd === input.root)
      blockers.push('This lane already runs in that folder.')
    return { mode: 'folder', branch: null, workspace, blockers }
  }
  if (target.top !== input.root)
    blockers.push('Pick the repository’s top folder as the target workspace.')
  if (git?.origin && target.origin === git.origin) {
    if (input.sameMachine)
      blockers.push('This lane is already in this repository on this machine. Use Clone instead.')
    if (!git.branch) blockers.push('This lane is not on a branch, so its code cannot follow it.')
    else if (git.trunk)
      blockers.push('This lane is on the default branch, which stays in the main checkout.')
    else if (!git.pushed)
      blockers.push(`Push ${git.branch} to origin first. Its exact commit must be on origin.`)
    if (!git.portable)
      blockers.push('Repositories with submodules or Git LFS cannot move lanes yet.')
    return { mode: 'same-workspace', branch: git.branch, workspace, blockers }
  }
  const own = git?.branch && !git.trunk && git.branch !== target.trunk ? git.branch : null
  const branch = own ?? `${input.branchPrefix}${slugifyTitle(source.title ?? 'moved lane')}`
  if (!isLaneBranchName(branch)) blockers.push('This lane’s branch name cannot be used there.')
  return { mode: 'new-branch', branch, workspace, blockers }
}

/** How a machine adds a worktree for `branch` under `root`, and takes it away again. */
export interface WorktreePort {
  add(root: string, branch: string, fresh: boolean): Promise<{ cwd: string; undo(): Promise<void> }>
}

export interface PreparedFolder {
  cwd: string
  branch: string | null
  worktree: boolean
  undo(): Promise<void>
}

const run = (root: string, args: string[]) =>
  git(root, args, { trim: true, env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } })
const exists = (root: string, ref: string) =>
  run(root, ['show-ref', '--verify', '--quiet', ref]).then(
    () => true,
    () => false,
  )

/** An existing clean worktree of this repository on `branch` at `commit`, which a second lane may share. */
async function sharedWorktree(root: string, branch: string, commit: string): Promise<string | null> {
  const list = await run(root, ['worktree', 'list', '--porcelain']).catch(() => '')
  const entry = list
    .split('\n\n')
    .map((block) => block.split('\n'))
    .find((lines) => lines.includes(`branch refs/heads/${branch}`))
  const path = entry?.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
  if (!path || !path.startsWith(join(root, '.phosphor', 'worktrees') + '/')) return null
  const head = await run(path, ['rev-parse', 'HEAD']).catch(() => '')
  const status = await git(path, ['status', '--porcelain', '--untracked-files=all']).catch(() => 'x')
  return head === commit && status.trim() === '' ? realpath(path) : null
}

/**
 * Make the target folder for `plan`. For the same repository the branch is
 * fetched from origin and must be exactly the source's commit; a local branch
 * of that name must already point there. Undo removes only what this created.
 */
export async function prepareTarget(input: {
  plan: LaneTargetPlan
  root: string
  source: LaneSourceFacts
  worktrees: WorktreePort
}): Promise<PreparedFolder> {
  const { plan, root } = input
  if (plan.blockers.length) refuse(plan.blockers[0]!)
  if (plan.mode === 'folder')
    return { cwd: await realpath(root), branch: null, worktree: false, undo: async () => {} }
  const branch = plan.branch
  if (!branch) refuse('This lane’s branch name cannot be used there.')
  const ref = `refs/heads/${branch}`
  if (plan.mode === 'new-branch') {
    if (await exists(root, ref))
      refuse(`A branch named ${branch} already exists in ${plan.workspace}.`)
    const added = await input.worktrees.add(root, branch, true)
    return { ...added, branch, worktree: true }
  }
  const commit = input.source.git?.commit
  if (!commit) refuse('This lane is not on a branch, so its code cannot follow it.')
  try {
    await git(root, ['fetch', '--no-tags', 'origin', ref], {
      env: NETWORK_GIT_ENV,
      timeout: NETWORK_TIMEOUT_MS,
    })
  } catch {
    refuse(`${plan.workspace} could not fetch ${branch} from origin.`)
  }
  if ((await run(root, ['rev-parse', 'FETCH_HEAD']).catch(() => '')) !== commit)
    refuse(`Origin’s ${branch} is not at this lane’s commit. Push it, then try again.`)
  let made = false
  if (await exists(root, ref)) {
    if ((await run(root, ['rev-parse', ref]).catch(() => '')) !== commit)
      refuse(`${plan.workspace} has its own ${branch} at another commit.`)
    const shared = await sharedWorktree(root, branch, commit)
    if (shared) return { cwd: shared, branch, worktree: true, undo: async () => {} }
  } else {
    await run(root, ['update-ref', ref, commit, '0'.repeat(commit.length)])
    made = true
  }
  const dropRef = async () => {
    if (made) await run(root, ['update-ref', '-d', ref, commit]).catch(() => undefined)
  }
  try {
    const added = await input.worktrees.add(root, branch, false)
    return {
      cwd: added.cwd,
      branch,
      worktree: true,
      undo: async () => {
        await added.undo()
        await dropRef()
      },
    }
  } catch (error) {
    await dropRef()
    throw error
  }
}
