import type {
  CheckoutResult,
  FetchResult,
  PullResult,
  UpdateFromMainResult,
} from '@phosphor/shared/models'
import { errorText } from '@phosphor/shared/errors'
import { dirtyCount, git, type GitRunner } from './git-exec'
import { listWorktreeMetadata } from './worktree-metadata'
import { mergeWithConflicts, type MergeOptions } from './checkout-mutations'

/**
 * Staying in sync with the remote: fetch, fast-forward pull, refreshing a
 * worktree from trunk, and checking a branch out in the main tree.
 *
 * Why this exists at all: nothing in Phosphor used to run `git fetch`, so the
 * `behind` count in `git-info.ts` was measured against whatever
 * `refs/remotes/origin/*` happened to be on disk. A repo nobody had fetched in
 * a week reported "up to date" forever, which is exactly the state the branch
 * menu now has to warn about.
 *
 * Everything here is result-union rather than throw for the *expected* refusals
 * (dirty tree, diverged history, branch held elsewhere) — same convention as
 * `git-worktrees.ts`, so the renderer can render a reason instead of a stack.
 */

/**
 * Per-repo throttle for background fetches.
 *
 * The branch menu asks for a fetch every time it opens, and the workspace asks
 * on every open — un-throttled that is a network round trip per popup, which on
 * a large repo over a slow link is seconds of spinner for a number that changes
 * a few times a day.
 */
const FETCH_TTL_MS = 3 * 60_000
const lastFetchAt = new Map<string, number>()
/** In-flight dedupe: two panels mounting at once must share one `git fetch`. */
const inFlight = new Map<string, Promise<FetchResult>>()

/**
 * `git fetch --prune`, at most once per FETCH_TTL_MS per repo unless forced.
 *
 * Never throws: being offline, having no remote, or lacking credentials are all
 * ordinary states here, and a failed background refresh must not break a menu
 * that is otherwise perfectly usable from local refs.
 */
export async function fetchRepo(
  repoPath: string,
  options: { force?: boolean; run?: GitRunner; args?: string[] } = {},
): Promise<FetchResult> {
  const previous = lastFetchAt.get(repoPath)
  if (!options.force && previous !== undefined && Date.now() - previous < FETCH_TTL_MS) {
    return { fetched: false, reason: 'throttled', at: previous }
  }

  const existing = inFlight.get(repoPath)
  if (existing) return existing

  const run = (async (): Promise<FetchResult> => {
    try {
      await (options.run ?? git)(repoPath, options.args ?? ['fetch', '--prune', '--quiet'])
      const at = Date.now()
      lastFetchAt.set(repoPath, at)
      return { fetched: true, at }
    } catch (err) {
      // Do NOT record the timestamp on failure: a repo that is offline right
      // now should retry on the next menu open, not sit out the full TTL.
      return {
        fetched: false,
        reason: 'failed',
        message: errorText(err),
      }
    } finally {
      inFlight.delete(repoPath)
    }
  })()

  inFlight.set(repoPath, run)
  return run
}

/** Testing seam — the throttle is module state and would leak across cases. */
export function resetFetchThrottle(): void {
  lastFetchAt.clear()
  inFlight.clear()
}

/**
 * Bring the checkout at `cwd` up to date with its upstream, fast-forward only.
 *
 * `--ff-only` is the whole point: a plain `git pull` on a diverged branch either
 * writes a merge commit or drops the user into a conflicted tree, and neither
 * belongs behind a one-click "Pull" button. Diverged branches are reported back
 * so the UI can say so and send the user to a real merge.
 */
export async function pullFastForward(cwd: string, run: GitRunner = git): Promise<PullResult> {
  let upstream: string
  try {
    upstream = (
      await run(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    ).trim()
  } catch {
    return { pulled: false, reason: 'no-upstream' }
  }

  const counts = (await run(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]))
    .trim()
    .split(/\s+/)
  const behind = Number.parseInt(counts[0] ?? '0', 10) || 0
  const ahead = Number.parseInt(counts[1] ?? '0', 10) || 0

  if (behind === 0) return { pulled: false, reason: 'up-to-date', upstream }
  if (ahead > 0) return { pulled: false, reason: 'diverged', upstream, ahead, behind }

  const dirty = await dirtyCount(cwd, run)
  if (dirty > 0) return { pulled: false, reason: 'dirty', dirtyCount: dirty }

  await run(cwd, ['merge', '--ff-only', upstream])
  return { pulled: true, upstream, commits: behind }
}

/**
 * Merge trunk into the worktree so a long-running branch stops rotting.
 *
 * Unlike `pullFastForward` this cannot be ff-only — a worktree with its own
 * commits has diverged from trunk by definition, and refusing that case would
 * make the action useless exactly when it is needed. Conflicts abort right
 * away, matching `mergeBranch`: Phosphor never leaves a tree mid-merge.
 */
export async function updateFromMain(
  worktreePath: string,
  mainBranch: string,
  options: MergeOptions = {},
): Promise<UpdateFromMainResult> {
  const run = options.run ?? git
  const behind = Number.parseInt(
    (await run(worktreePath, ['rev-list', '--count', `HEAD..${mainBranch}`])).trim(),
    10,
  )
  if (!behind) return { updated: false, reason: 'up-to-date' }

  const dirty = await dirtyCount(worktreePath, run)
  if (dirty > 0) return { updated: false, reason: 'dirty', dirtyCount: dirty }

  const conflicts = await mergeWithConflicts(worktreePath, ['--no-edit', mainBranch], options)
  if (conflicts) return { updated: false, reason: 'conflict', conflicts }

  return {
    updated: true,
    commits: behind,
    sha: (await run(worktreePath, ['rev-parse', 'HEAD'])).trim(),
  }
}

/**
 * Check `branch` out in the working tree at `repoPath`.
 *
 * This reverses a standing rule — `docs/worktrees.md` used to say the main
 * tree's checkout is never changed by Phosphor — so the guards carry the weight
 * the rule used to. A checkout is refused outright when the tree is dirty
 * (git would either fail or carry changes across, and neither is something a
 * user expects from picking a branch in a menu) and when another worktree
 * already holds the branch (git refuses this itself, but with a message that
 * names a path the user has no context for).
 */
export async function checkoutBranch(
  repoPath: string,
  branch: string,
  options: { run?: GitRunner; localOnly?: true } = {},
): Promise<CheckoutResult> {
  const run = options.run ?? git
  const dirty = await dirtyCount(repoPath, run)
  if (dirty > 0) return { checkedOut: false, reason: 'dirty', dirtyCount: dirty }

  // `worktree list --porcelain` rather than trusting git's own error: we want
  // to name the holder before attempting anything that could half-apply.
  const held = await heldBy(repoPath, branch, run)
  if (held !== null) return { checkedOut: false, reason: 'held', worktreePath: held }

  await run(
    repoPath,
    options.localOnly
      ? ['switch', '--no-guess', '--no-overwrite-ignore', '--', branch]
      : ['checkout', branch],
  )
  return { checkedOut: true, branch }
}

/** Path of the worktree that has `branch` checked out, excluding `repoPath`. */
async function heldBy(repoPath: string, branch: string, run: GitRunner): Promise<string | null> {
  const worktrees = await listWorktreeMetadata(repoPath, run)
  const held = worktrees.find((w) => w.branch === branch && w.path !== repoPath)
  return held?.path ?? null
}
