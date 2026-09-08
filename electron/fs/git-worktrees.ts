import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { AddWorktreeBranch, BranchInfo, StartPoint, WorktreeInfo } from '@shared/models'
import { abortMergeAndCollectConflicts, dirtyCount, git, gitErrorText } from './git-exec'

const execFileAsync = promisify(execFile)

/**
 * Worktree lifecycle for Phosphor sessions.
 *
 * Layout decision: worktrees live INSIDE the repo at
 * `<repo>/.phosphor/worktrees/<name>` (mirroring the `.claude/worktrees`
 * convention), ignored via `.git/info/exclude` so `git status` stays clean
 * without touching tracked files. In-repo keeps them discoverable from a
 * plain file listing, and its `git:info` (`isWorktree` / `mainRepoPath`) is
 * what lets the sidebar fold a worktree's sessions back into its main repo's
 * group instead of giving each worktree its own top-level entry.
 *
 * Two standing rules:
 * - The main tree's checkout is NEVER changed on the user's behalf.
 * - Nothing uncommitted is deleted without an explicit force.
 */

/** Both dir name and branch name — reject anything path- or ref-hostile. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export function worktreeRootFor(repoPath: string): string {
  return join(repoPath, '.phosphor', 'worktrees')
}

/**
 * Resolve symlinks the way pi does (`realpathSync.native`) so worktree paths
 * compare equal to session cwds.
 */
export function normalizeRealPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Parse `git worktree list --porcelain` output. Exported pure for tests. */
export function parseWorktreeList(
  output: string,
): Array<Pick<WorktreeInfo, 'path' | 'branch' | 'head' | 'locked' | 'prunable'>> {
  const result: Array<Pick<WorktreeInfo, 'path' | 'branch' | 'head' | 'locked' | 'prunable'>> = []
  let current: {
    path?: string
    branch: string | null
    head: string
    locked: boolean
    prunable: boolean
  } | null = null
  const flush = (): void => {
    if (current?.path) {
      result.push({
        path: current.path,
        branch: current.branch,
        head: current.head,
        locked: current.locked,
        prunable: current.prunable,
      })
    }
    current = null
  }
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice(9), branch: null, head: '', locked: false, prunable: false }
    } else if (!current) {
      continue
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, '')
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true
    } else if (line === 'detached') {
      current.branch = null
    }
  }
  flush()
  return result
}

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const parsed = parseWorktreeList(await git(repoPath, ['worktree', 'list', '--porcelain']))
  const mainPath = parsed[0]?.path
  return Promise.all(
    parsed.map(async (wt) => {
      let dirty = -1
      if (existsSync(wt.path)) {
        try {
          dirty = await dirtyCount(wt.path)
        } catch {
          dirty = -1
        }
      }
      return {
        ...wt,
        realPath: normalizeRealPath(wt.path),
        isMain: wt.path === mainPath,
        dirtyCount: dirty,
      }
    }),
  )
}

export async function listBranches(
  repoPath: string,
): Promise<{ branches: BranchInfo[]; defaultBranch: string }> {
  const [refs, worktrees, currentBranch] = await Promise.all([
    git(repoPath, [
      'for-each-ref',
      'refs/heads',
      '--format=%(refname:short)\t%(committerdate:unix)\t%(subject)',
    ]),
    listWorktrees(repoPath),
    git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim()),
  ])

  const byBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch!, w.path]))
  const branches: BranchInfo[] = refs
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', date = '', ...subject] = line.split('\t')
      return {
        name,
        isCurrent: name === currentBranch,
        worktreePath: byBranch.get(name),
        lastCommitSubject: subject.join('\t') || undefined,
        lastCommitAt: date ? Number.parseInt(date, 10) * 1000 : undefined,
      }
    })
    .sort((a, b) => (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0))

  const defaultBranch = await defaultBranchOf(repoPath, {
    names: new Set(branches.map((b) => b.name)),
    currentBranch,
  })

  await enrichWithSync(repoPath, branches, defaultBranch)
  return { branches, defaultBranch }
}

/**
 * This repo's trunk: what `origin/HEAD` points at, else `main`/`master` if one
 * exists locally, else whatever is checked out.
 *
 * Hints let `listBranches` reuse the branch names and current branch it has
 * already paid for; `startPoint` has neither and asks git directly.
 */
async function defaultBranchOf(
  repoPath: string,
  hints: { names?: Set<string>; currentBranch?: string } = {},
): Promise<string> {
  try {
    return (await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))
      .trim()
      .replace(/^origin\//, '')
  } catch {
    // No origin/HEAD (no remote, or never set) — fall back to local names.
  }
  const names =
    hints.names ??
    new Set(
      (await git(repoPath, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    )
  if (names.has('main')) return 'main'
  if (names.has('master')) return 'master'
  return hints.currentBranch ?? (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
}

/**
 * Where a new session branch should start.
 *
 * Prefers `origin/<trunk>` over local trunk deliberately. "Branch off the
 * latest main" is the actual intent, and the local `main` in a repo the user
 * has been working in for a week is routinely stale — but bringing it up to
 * date would mean pulling, which fails outright on a dirty main tree and is
 * exactly the kind of surprise a "new chat" button must not spring. Branching
 * straight off the remote-tracking ref gets the freshest trunk while leaving
 * the main tree's checkout untouched, dirty or not.
 *
 * The caller is expected to have fetched (throttled) first; without a fetch
 * this is still correct, just as fresh as the last fetch.
 */
export async function startPoint(repoPath: string): Promise<StartPoint> {
  const defaultBranch = await defaultBranchOf(repoPath)
  if (await refExists(repoPath, `refs/remotes/origin/${defaultBranch}`)) {
    return { base: `origin/${defaultBranch}`, defaultBranch, fromRemote: true }
  }
  if (await refExists(repoPath, `refs/heads/${defaultBranch}`)) {
    return { base: defaultBranch, defaultBranch, fromRemote: false }
  }
  // Neither ref resolves: a repo whose trunk is unborn or oddly named. HEAD is
  // always *something*, and branching from it beats refusing to start a chat.
  return { base: 'HEAD', defaultBranch, fromRemote: false }
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await git(repoPath, ['show-ref', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

/**
 * Add upstream tracking and distance-from-trunk to an already-built branch
 * list, without a `rev-list` per branch.
 *
 * Deliberately TWO `for-each-ref` calls rather than one with all four atoms.
 * `%(ahead-behind:)` is git 2.41+ (June 2023) and an unknown atom makes git
 * fail the whole command — Ubuntu 22.04 LTS still ships 2.34 — so bundling it
 * with `%(upstream:*)` would cost every older install its "you are N behind
 * origin, pull?" prompt as collateral. Splitting them means old git loses only
 * the behind-trunk markers, which the UI renders as unknown, never as zero.
 *
 * A second pass rather than atoms on `listBranches`' first query because
 * `%(ahead-behind:)` needs the default branch, and resolving that needs the
 * branch names the first query produces.
 */
async function enrichWithSync(
  repoPath: string,
  branches: BranchInfo[],
  defaultBranch: string,
): Promise<void> {
  const byName = new Map(branches.map((b) => [b.name, b]))

  // Pass 1: upstream tracking. These atoms are ancient; a failure here means
  // something is wrong with the repo itself, not with git's vintage.
  try {
    const format = ['%(refname:short)', '%(upstream:short)', '%(upstream:track,nobracket)'].join(
      '\t',
    )
    const out = await git(repoPath, ['for-each-ref', 'refs/heads', `--format=${format}`])
    for (const line of out.split('\n').filter(Boolean)) {
      const [name = '', upstream = '', track = ''] = line.split('\t')
      const branch = byName.get(name)
      if (!branch || !upstream) continue
      branch.upstream = upstream
      // `track` is "ahead 2, behind 1", "gone", or empty when in sync.
      if (track !== 'gone') {
        branch.ahead = Number.parseInt(/ahead (\d+)/.exec(track)?.[1] ?? '0', 10)
        branch.behind = Number.parseInt(/behind (\d+)/.exec(track)?.[1] ?? '0', 10)
      }
    }
  } catch {
    // Leave tracking unknown.
  }

  // Pass 2: distance from trunk, best-effort (see the git 2.41 note above).
  try {
    const format = ['%(refname:short)', `%(ahead-behind:refs/heads/${defaultBranch})`].join('\t')
    const out = await git(repoPath, ['for-each-ref', 'refs/heads', `--format=${format}`])
    for (const line of out.split('\n').filter(Boolean)) {
      const [name = '', aheadBehind = ''] = line.split('\t')
      const branch = byName.get(name)
      if (!branch) continue
      // "<ahead> <behind>" relative to trunk; the second number is what "this
      // worktree has fallen behind main" means. Blank on unborn/unknown refs.
      const behindDefault = aheadBehind.trim().split(/\s+/)[1]
      if (behindDefault !== undefined && /^\d+$/.test(behindDefault)) {
        branch.behindDefault = Number.parseInt(behindDefault, 10)
      }
    }
  } catch {
    // git < 2.41: no behind-trunk markers, everything else still works.
  }
}

/** Append `/.phosphor/` to .git/info/exclude once (never touches .gitignore). */
async function ensureExcluded(repoPath: string): Promise<void> {
  const commonDir = (
    await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).trim()
  const excludePath = join(commonDir, 'info', 'exclude')
  let existing = ''
  try {
    existing = await readFile(excludePath, 'utf8')
  } catch {
    // no exclude file yet
  }
  if (existing.split('\n').some((l) => l.trim() === '/.phosphor/')) return
  await mkdir(join(commonDir, 'info'), { recursive: true })
  await appendFile(excludePath, `${existing.endsWith('\n') || !existing ? '' : '\n'}/.phosphor/\n`)
}

export async function addWorktree(
  repoPath: string,
  name: string,
  branch: AddWorktreeBranch,
): Promise<WorktreeInfo> {
  if (!NAME_PATTERN.test(name) || name.includes('..')) {
    throw new Error(`Invalid worktree name "${name}" — letters, digits, ./_- only.`)
  }
  if (branch.kind === 'new' && branch.branch !== undefined) {
    if (!NAME_PATTERN.test(branch.branch) || branch.branch.includes('..')) {
      throw new Error(`Invalid branch name "${branch.branch}" — letters, digits, ./_- only.`)
    }
  }
  const path = join(worktreeRootFor(repoPath), name)
  if (existsSync(path)) {
    throw new Error(`Worktree folder already exists: ${path}`)
  }

  if (branch.kind === 'existing') {
    const [worktrees, { defaultBranch }] = await Promise.all([
      listWorktrees(repoPath),
      listBranches(repoPath),
    ])
    const taken = worktrees.find((w) => w.branch === branch.branch)
    if (taken) {
      throw new Error(
        `Branch "${branch.branch}" is already checked out in ${taken.isMain ? 'the main tree' : taken.path}.`,
      )
    }
    // Trunk belongs to the main working tree. git only refuses this while the
    // branch is *currently* checked out, so from a feature branch it would
    // happily move trunk into a worktree — and then the main tree can never
    // check it out again ("fatal: 'main' is already used by worktree at …").
    // A worktree is for parallel work beside trunk, never instead of it.
    if (branch.branch === defaultBranch) {
      throw new Error(
        `"${branch.branch}" is this repo's default branch — it belongs in the main working tree. ` +
          `Putting it in a worktree would stop the main tree from ever checking it out. ` +
          `Open the main tree to work on ${branch.branch}, or branch off it instead.`,
      )
    }
  }

  await mkdir(worktreeRootFor(repoPath), { recursive: true })
  await ensureExcluded(repoPath)

  if (branch.kind === 'new') {
    // `--no-track` when the base is a remote-tracking ref: git would otherwise
    // make `origin/main` the new branch's upstream, so the branch chip would
    // report it as "behind origin/main" forever and `git push` would aim at
    // trunk. Distance from trunk is already reported via `behindDefault`.
    const args = ['worktree', 'add', '-b', branch.branch ?? name]
    if (branch.noTrack) args.push('--no-track')
    args.push(path, branch.base)
    await git(repoPath, args)
  } else {
    await git(repoPath, ['worktree', 'add', path, branch.branch])
  }

  const worktrees = await listWorktrees(repoPath)
  const created = worktrees.find((w) => w.path === path || w.realPath === normalizeRealPath(path))
  if (!created) throw new Error('Worktree was created but not found in `git worktree list`.')
  return created
}

/**
 * Rename a branch, including one checked out in a linked worktree.
 *
 * This exists because a chat's branch is now cut before its name is known. The
 * naming model costs ~13s, and waiting for it is what made "new chat" feel
 * hung, so the branch is cut immediately from a slug of the first message and
 * brought into agreement with the generated title afterwards.
 *
 * `git branch -m` is safe on a branch that a linked worktree has checked out —
 * git rewrites that worktree's HEAD, so the live pi session running there is
 * undisturbed (its cwd, which is what binds it to its transcript, never
 * moves). The worktree *folder* keeps its original slug on purpose: moving it
 * would move a live session's cwd out from under it.
 *
 * Never throws for the ordinary refusals — a rename is cosmetic, and a chat
 * that is already running must not surface an error because its branch could
 * not be retitled.
 */
export async function renameBranch(
  repoPath: string,
  from: string,
  to: string,
): Promise<{ renamed: boolean; branch: string }> {
  if (from === to) return { renamed: false, branch: from }
  if (!NAME_PATTERN.test(to) || to.includes('..')) {
    return { renamed: false, branch: from }
  }
  try {
    // No `-M`: a plain `-m` refuses to clobber an existing branch, which is
    // the behaviour we want if the caller's dedupe raced another session.
    await git(repoPath, ['branch', '-m', from, to])
    return { renamed: true, branch: to }
  } catch {
    return { renamed: false, branch: from }
  }
}

/**
 * Is this branch's work already on the trunk, squash merges included?
 *
 * `git branch -d` only asks "is it an ancestor", and a squash merge rewrites
 * the branch into one new commit that has no ancestry link back to it. Phosphor
 * lanes land as squash-merged PRs, so `-d` refused EVERY merged lane and the
 * delete flow reported an error on each one — the branch was safe to drop the
 * whole time.
 *
 * The squash test is the standard one: synthesise a commit holding the
 * branch's tree on top of the merge base, then ask `git cherry` whether an
 * equivalent patch is already upstream. The synthesised commit is dangling and
 * unreferenced, so gc collects it.
 *
 * Both `origin/<trunk>` and local `<trunk>` are checked: the squash commit is
 * on the remote the moment the PR merges, and reaches local trunk only after
 * a pull. Anything unexpected answers "not merged" — the caller escalates to
 * `-D` on a true, so an error must never read as proof.
 */
export async function isBranchMerged(repoPath: string, branch: string): Promise<boolean> {
  const { defaultBranch } = await startPoint(repoPath)
  if (branch === defaultBranch) return false

  const bases: string[] = []
  for (const ref of [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`]) {
    if (await refExists(repoPath, ref)) bases.push(ref)
  }

  for (const base of bases) {
    try {
      await git(repoPath, ['merge-base', '--is-ancestor', branch, base])
      return true
    } catch {
      // Not an ancestor. It can still have been squashed onto the trunk.
    }
    try {
      const mergeBase = await git(repoPath, ['merge-base', base, branch], { trim: true })
      const tree = await git(repoPath, ['rev-parse', `${branch}^{tree}`], { trim: true })
      if (!mergeBase || !tree) continue
      const probe = await git(
        repoPath,
        ['commit-tree', tree, '-p', mergeBase, '-m', 'Phosphor squash-merge probe'],
        { trim: true },
      )
      // `git cherry` prefixes '-' when an equivalent patch is already upstream.
      if ((await git(repoPath, ['cherry', base, probe], { trim: true })).startsWith('-')) {
        return true
      }
    } catch {
      // Cannot prove it — fall through to the next base, then to false.
    }
  }
  return false
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  options: { force?: boolean; deleteBranch?: boolean } = {},
): Promise<
  | { removed: true; branchDeleted: boolean; branchError?: string }
  | { removed: false; dirtyCount: number }
> {
  const worktrees = await listWorktrees(repoPath)
  const target = worktrees.find(
    (w) => w.path === worktreePath || w.realPath === normalizeRealPath(worktreePath),
  )
  if (!target) throw new Error(`Not a linked worktree of this repo: ${worktreePath}`)
  if (target.isMain) throw new Error('Refusing to remove the main working tree.')

  if (!options.force && target.dirtyCount > 0) {
    return { removed: false, dirtyCount: target.dirtyCount }
  }

  const args = ['worktree', 'remove']
  if (options.force) args.push('--force')
  args.push(target.path)
  await git(repoPath, args)

  let branchDeleted = false
  let branchError: string | undefined
  if (options.deleteBranch && target.branch) {
    const branch = target.branch
    try {
      await git(repoPath, ['branch', '-d', branch])
      branchDeleted = true
    } catch (error) {
      // `-d` refuses a squash-merged branch, which is how every Phosphor lane
      // lands. Escalate to `-D` ONLY when the squash test proves the work is
      // already on the trunk; a genuinely unmerged branch is still kept and
      // reported, never forced.
      if (await isBranchMerged(repoPath, branch)) {
        try {
          await git(repoPath, ['branch', '-D', branch])
          branchDeleted = true
        } catch (forceError) {
          branchError = gitErrorText(forceError)
        }
      } else {
        branchError = gitErrorText(error)
      }
    }
  }
  return { removed: true, branchDeleted, branchError }
}

export async function pruneWorktrees(repoPath: string): Promise<{ pruned: string[] }> {
  // --verbose reports removals on stderr.
  const { stdout, stderr } = await execFileAsync('git', ['worktree', 'prune', '--verbose'], {
    cwd: repoPath,
    timeout: 30_000,
  })
  const pruned = `${stdout}\n${stderr}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return { pruned }
}

/** Stage everything and commit in the worktree. Refuses empty messages. */
export async function commitAll(worktreePath: string, message: string): Promise<{ sha: string }> {
  if (!message.trim()) throw new Error('Commit message must not be empty.')
  await git(worktreePath, ['add', '-A'])
  await git(worktreePath, ['commit', '-m', message])
  return { sha: (await git(worktreePath, ['rev-parse', 'HEAD'])).trim() }
}

/**
 * Merge `branch` into the main tree's current branch. Preflight requires the
 * main tree to be clean (we never checkout or stash for the user); a conflict
 * aborts immediately so the repo is never left mid-merge.
 */
export async function mergeBranch(
  repoPath: string,
  branch: string,
): Promise<
  | { merged: true; sha: string }
  | { merged: false; reason: 'dirty'; dirtyCount: number }
  | { merged: false; reason: 'conflict'; conflicts: string[] }
> {
  const dirty = await dirtyCount(repoPath)
  if (dirty > 0) {
    return { merged: false, reason: 'dirty', dirtyCount: dirty }
  }
  try {
    await git(repoPath, ['merge', '--no-ff', '--no-edit', branch])
  } catch {
    return {
      merged: false,
      reason: 'conflict',
      conflicts: await abortMergeAndCollectConflicts(repoPath),
    }
  }
  return { merged: true, sha: (await git(repoPath, ['rev-parse', 'HEAD'])).trim() }
}
