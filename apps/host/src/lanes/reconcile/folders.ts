import { lstat, opendir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepositorySummary } from '@phosphor/shared/host-protocol'
import { errnoIs, isInside } from '../../fs-safety'
import type { ScanState } from '../reconcile'

export const RECONCILE_LIMITS = {
  worktreesPerRepository: 256,
} as const

async function discoverWorktrees(
  state: ScanState,
  repository: RepositorySummary,
  signal?: AbortSignal,
): Promise<void> {
  const directory = join(repository.path, '.phosphor', 'worktrees')
  try {
    const info = await lstat(directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !isInside(repository.path, await realpath(directory))
    ) {
      state.skipped++
      return
    }
    let entries = 0
    for await (const entry of await opendir(directory)) {
      signal?.throwIfAborted()
      if (++entries > RECONCILE_LIMITS.worktreesPerRepository) {
        state.skipped++
        break
      }
      const path = join(directory, entry.name)
      try {
        const info = await lstat(path)
        const real = await realpath(path)
        if (!info.isDirectory() || info.isSymbolicLink() || !isInside(repository.path, real)) {
          state.skipped++
          continue
        }
        state.folders.set(real, repository.id)
      } catch {
        state.skipped++
      }
    }
  } catch (error) {
    signal?.throwIfAborted()
    if (!(error instanceof Error && errnoIs(error, 'ENOENT'))) state.skipped++
  }
}

export async function discoverFolders(state: ScanState, signal?: AbortSignal): Promise<void> {
  for (const repository of state.repositories) {
    signal?.throwIfAborted()
    state.folders.set(repository.path, repository.id)
    await discoverWorktrees(state, repository, signal)
  }
  for (const lane of state.known) {
    signal?.throwIfAborted()
    if (!state.repositories.some((repository) => repository.id === lane.repositoryId)) continue
    let cwd = lane.cwd
    try {
      cwd = await realpath(cwd)
    } catch {
      // A deleted worktree still needs its known files checked for ENOENT.
    }
    state.folders.set(cwd, lane.repositoryId)
  }
}
