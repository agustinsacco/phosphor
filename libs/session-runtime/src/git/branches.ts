import type { BranchInfo, StartPoint } from '@phosphor/shared/models'
import { git, type GitRunner } from './git-exec'
import { listWorktreeMetadata } from './worktree-metadata'

export async function listBranches(
  repoPath: string,
  run: GitRunner = git,
  compact = false,
): Promise<{ branches: BranchInfo[]; defaultBranch: string }> {
  const [refs, worktrees, currentBranch] = await Promise.all([
    run(repoPath, [
      'for-each-ref',
      'refs/heads',
      '--format=%(refname:short)\t%(committerdate:unix)\t%(subject)',
    ]),
    listWorktreeMetadata(repoPath, run),
    run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim()),
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

  const defaultBranch = await defaultBranchOf(
    repoPath,
    {
      names: new Set(branches.map((b) => b.name)),
      currentBranch,
    },
    run,
  )

  if (!compact) await enrichWithSync(repoPath, branches, defaultBranch)
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
  run: GitRunner = git,
): Promise<string> {
  try {
    return (await run(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))
      .trim()
      .replace(/^origin\//, '')
  } catch {
    // No origin/HEAD (no remote, or never set) — fall back to local names.
  }
  const names =
    hints.names ??
    new Set(
      (await run(repoPath, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    )
  if (names.has('main')) return 'main'
  if (names.has('master')) return 'master'
  return hints.currentBranch ?? (await run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
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
export async function startPoint(repoPath: string, run: GitRunner = git): Promise<StartPoint> {
  const defaultBranch = await defaultBranchOf(repoPath, {}, run)
  if (await refExists(repoPath, `refs/remotes/origin/${defaultBranch}`, run)) {
    return { base: `origin/${defaultBranch}`, defaultBranch, fromRemote: true }
  }
  if (await refExists(repoPath, `refs/heads/${defaultBranch}`, run)) {
    return { base: defaultBranch, defaultBranch, fromRemote: false }
  }
  // Neither ref resolves: a repo whose trunk is unborn or oddly named. HEAD is
  // always *something*, and branching from it beats refusing to start a chat.
  return { base: 'HEAD', defaultBranch, fromRemote: false }
}

export async function refExists(
  repoPath: string,
  ref: string,
  run: GitRunner = git,
): Promise<boolean> {
  try {
    await run(repoPath, ['show-ref', '--verify', '--quiet', ref])
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
  run = git,
): Promise<void> {
  const byName = new Map(branches.map((b) => [b.name, b]))

  // Pass 1: upstream tracking. These atoms are ancient; a failure here means
  // something is wrong with the repo itself, not with git's vintage.
  try {
    const format = ['%(refname:short)', '%(upstream:short)', '%(upstream:track,nobracket)'].join(
      '\t',
    )
    const out = await run(repoPath, ['for-each-ref', 'refs/heads', `--format=${format}`])
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
    const out = await run(repoPath, ['for-each-ref', 'refs/heads', `--format=${format}`])
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
