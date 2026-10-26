import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  ghPrForBranch as queryBranch,
  ghPrsForRepo as queryRepo,
} from '@phosphor/session-runtime/git/github'
import { piProcessEnv } from '../pi/shell-env'

export {
  summarizeChecks,
  toPullRequest,
  preferPr,
  indexPrsByBranch,
} from '@phosphor/session-runtime/git/github'

const execFileAsync = promisify(execFile)

/** Login-shell PATH for GUI launches; gh owns credentials, never Phosphor. */
function ghEnv(): Promise<Record<string, string>> {
  return piProcessEnv({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' })
}

let availability: Promise<boolean> | null = null
export function ghAvailable(): Promise<boolean> {
  availability ??= ghEnv()
    .then((env) => execFileAsync('gh', ['--version'], { timeout: 5_000, env }))
    .then(
      () => true,
      () => false,
    )
  return availability
}

/** Read-only: missing gh, credentials or GitHub remote are normal unavailable states. */
async function gh(cwd: string, args: string[]): Promise<string | null> {
  if (!(await ghAvailable())) return null
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      env: await ghEnv(),
    })
    return stdout
  } catch {
    return null
  }
}

export const ghPrForBranch = (repoPath: string, branch: string) => queryBranch(gh, repoPath, branch)
export const ghPrsForRepo = (repoPath: string, limit = 100) => queryRepo(gh, repoPath, limit)

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** Read-only merge evidence; callers must also prove the local branch is covered. */
export async function ghMergedPrHeads(repoPath: string, branch: string): Promise<string[] | null> {
  if (!branch) return null
  const raw = await gh(repoPath, [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'merged',
    '--limit',
    '20',
    '--json',
    'headRefOid',
  ])
  if (raw === null) return null
  try {
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows)) return null
    return rows
      .map((row: { headRefOid?: unknown }) => row?.headRefOid)
      .filter((oid): oid is string => typeof oid === 'string' && OID.test(oid))
  } catch {
    return null
  }
}

/** A commit never changes its tree, so one answer per commit is enough. */
const commitTrees = new Map<string, string>()
export async function ghCommitTree(repoPath: string, oid: string): Promise<string | null> {
  if (!OID.test(oid)) return null
  const cached = commitTrees.get(oid)
  if (cached) return cached
  const raw = await gh(repoPath, [
    'api',
    `repos/{owner}/{repo}/git/commits/${oid}`,
    '--jq',
    '.tree.sha',
  ])
  const tree = raw?.trim() ?? ''
  if (!OID.test(tree)) return null
  commitTrees.set(oid, tree)
  return tree
}
