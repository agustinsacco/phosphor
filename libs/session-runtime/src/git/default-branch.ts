/**
 * The Host's one rule for a repository's trunk.
 *
 * Lane creation bases new branches on it and refuses it as a lane branch; lane
 * deletion proves merges against it. They used to resolve it separately, so a
 * develop-only repository created lanes from `develop` and proved them against
 * an assumed `master`, and no merged lane branch was ever deleted.
 */

/** Runs git in the repository: trimmed stdout, rejecting on a non-zero exit. */
export type RepositoryGit = (args: string[]) => Promise<string>

const ORIGIN = 'refs/remotes/origin/'
const HEADS = 'refs/heads/'

/**
 * origin/HEAD's branch, else an existing `main`, else an existing `master`,
 * else the branch HEAD names when that branch has a commit.
 *
 * Null when none applies (a detached or unborn HEAD without candidates). There
 * is no trunk then: creation may branch from the HEAD commit, deletion has no
 * proof. Literal `HEAD` is never returned. A failed ref listing rejects.
 */
export async function resolveDefaultBranch(run: RepositoryGit): Promise<string | null> {
  const origin = await run(['symbolic-ref', '--quiet', `${ORIGIN}HEAD`]).catch(() => '')
  if (origin.startsWith(ORIGIN) && origin.length > ORIGIN.length) return origin.slice(ORIGIN.length)
  const current = await run(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')
  const candidates = [`${HEADS}main`, `${HEADS}master`]
  if (current.startsWith(HEADS) && current.length > HEADS.length) candidates.push(current)
  const existing = (await run(['for-each-ref', '--format=%(refname)', ...candidates])).split('\n')
  const trunk = candidates.find((ref) => existing.includes(ref))
  return trunk ? trunk.slice(HEADS.length) : null
}

/**
 * The trunk's refs, freshest first: creation's base order and deletion's proof
 * bases, so a lane is proven against what it was created from.
 */
export function defaultBranchRefs(trunk: string): [remote: string, local: string] {
  return [`${ORIGIN}${trunk}`, `${HEADS}${trunk}`]
}
