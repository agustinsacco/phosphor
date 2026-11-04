import type { GhPullRequest } from '@phosphor/shared/models'
import { git } from './git-exec'

/** Only supplement truncated listings, in batches rather than one subprocess per lane. */
export async function worktreePrSearches(
  repoPath: string,
  known: Record<string, GhPullRequest>,
): Promise<string[]> {
  try {
    const output = await git(repoPath, ['worktree', 'list', '--porcelain', '-z'], {
      isolateEnv: true,
      maxBuffer: 1024 * 1024,
    })
    const branches = new Set(
      output
        .split('\0')
        .filter((field) => field.startsWith('branch refs/heads/'))
        .map((field) => field.slice('branch refs/heads/'.length))
        .filter((branch) => branch && !Object.hasOwn(known, branch)),
    )
    const searches: string[] = []
    let terms: string[] = []
    for (const branch of branches) {
      // Repeated head qualifiers are ORed by GitHub. Quote each literal ref so
      // a branch name cannot inject other search qualifiers.
      const term = `head:${JSON.stringify(branch)}`
      if (terms.length && (terms.length >= 20 || [...terms, term].join(' ').length > 4000)) {
        searches.push(terms.join(' '))
        terms = []
      }
      terms.push(term)
    }
    if (terms.length) searches.push(terms.join(' '))
    return searches
  } catch {
    // Discovery failure must not discard PRs the repository listing did find.
    return []
  }
}
