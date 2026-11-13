import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import {
  ghPrForBranch as queryBranch,
  ghPrsForRepo as queryRepo,
} from '@phosphor/session-runtime/git/github'
import { piProcessEnv } from '../pi/shell-env'
import { createGithubReader } from '@phosphor/session-runtime/git/github-reader'
import { runGithubCommand, type GithubCommand } from '@phosphor/session-runtime/git/github-command'
import { GithubGate } from '@phosphor/session-runtime/git/github-gate'
import { createGithubPrStatusReader } from '@phosphor/session-runtime/git/github-pr-status'
import { githubEvidence } from '@phosphor/session-runtime/git/branch-landed'
import type { GhPrReadOptions } from '@shared/models'

const command: GithubCommand = async (cwd, args, signal) =>
  runGithubCommand(cwd, args, await ghEnv(), signal)
// One queue and rate-limit pause for branch discovery and PR status alike.
const gate = new GithubGate(command)
const reader = createGithubReader({ run: command, gate })
const prStatus = createGithubPrStatusReader({ gate, cwd: homedir() })
export const readRepositoryPrs = (repoPath: string, options?: GhPrReadOptions) =>
  reader.read(repoPath, options)
/** Arguments arrive from the renderer unchecked; the reader validates them. */
export const readPrSummaries = async (refs: unknown, options?: unknown) =>
  (await ghAvailable()) ? prStatus.read(refs, options) : null

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
      () => {
        // A missing CLI may be installed while the app is running. Share only
        // in-flight failures; keep successful availability cached.
        availability = null
        return false
      },
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

/** Read-only merge evidence; callers must also prove the local branch is covered. */
export const ghEvidence = (repoPath: string) => githubEvidence(gh, repoPath)
