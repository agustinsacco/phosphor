import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { walkFiles } from '@phosphor/session-runtime/files/walk'
import { MAX_LISTED_FILES } from '@shared/workspace-search'

const execFileAsync = promisify(execFile)

export interface WorkspaceFileList {
  /** Workspace-relative, `/`-separated: git's tracked files, then its untracked ones. */
  files: string[]
  /** The workspace holds more than `MAX_LISTED_FILES`; `files` is the first of them. */
  truncated: boolean
}

/**
 * List workspace files for @-mentions, the fuzzy finder and the workspace search.
 * Prefers `git ls-files` (gitignore-aware, fast); falls back to the bounded
 * walk the Host uses too (`walkFiles`).
 *
 * `-z` because without it git quotes any path outside plain ASCII
 * (`"caf\303\251.md"`), which then names no file on disk.
 *
 * `signal` stops the listing part-way (git is killed) and rejects with its
 * reason.
 */
export async function listWorkspaceFileList(
  workspacePath: string,
  signal?: AbortSignal,
): Promise<WorkspaceFileList> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: workspacePath, maxBuffer: 32 * 1024 * 1024, timeout: 15_000, signal },
    )
    // A conflicted path is listed once per merge stage.
    const files = [...new Set(stdout.split('\0').filter(Boolean))]
    if (files.length > 0) {
      return {
        files: files.slice(0, MAX_LISTED_FILES),
        truncated: files.length > MAX_LISTED_FILES,
      }
    }
  } catch {
    // Not a git repo — fall through, unless the listing was stopped.
    signal?.throwIfAborted()
  }
  return walkFiles(workspacePath, MAX_LISTED_FILES, signal)
}

export async function listWorkspaceFiles(workspacePath: string): Promise<string[]> {
  return (await listWorkspaceFileList(workspacePath)).files
}
