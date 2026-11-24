import { rename } from 'node:fs/promises'
import { rebaseWithinFolder } from '@phosphor/shared/paths'
import { planSandboxRename, resolveSandboxFolder, sandboxCwds } from './folders'
import { claudeProjectDirForCwd, sessionDirForCwd, piSessionsRoot } from '../pi/pi-paths'
import { moveIfPresent, repointTranscripts, trashIfPresent } from './transcripts'

export interface SandboxOwner {
  env?: NodeJS.ProcessEnv
  home?: string
  retainedCwds?(path: string): readonly string[]
  guardTranscripts?(sources: readonly string[], targets?: readonly string[]): Promise<void>
  hasLiveFolder(path: string): boolean
  hasArchivedFolder(path: string): Promise<boolean>
  trashItem(path: string): Promise<void>
  repointStoredPaths(moves: readonly { from: string; to: string }[]): void
  forgetWorkspace(path: string): void
}

/**
 * Renaming a sandbox moves its folder, so it moves the sandbox's IDENTITY:
 * a workspace is its path here, and pi names a transcript directory after
 * the mangled cwd. Three things therefore have to move together, or the
 * rename reads as data loss — the folder, pi's transcripts, and the CLI's.
 *
 * "Its" transcripts means the whole subtree, not just the sandbox root. A
 * sandbox that is a git repo has lanes, each its own cwd with its own pair
 * of transcript directories (`sandboxCwds`). Moving only the root's pair
 * left every lane chat pointing at a path that no longer existed, and they
 * vanished from the sidebar along with their pins, markers and badges.
 *
 * Refused while a session is live ANYWHERE inside the folder, for the same
 * subtree reason: a lane session's cwd is under the sandbox, so an exact
 * path compare passed it and renamed the folder out from under a running
 * pi. The renderer closes those chats in order before asking
 * (`promptRenameSandbox`); this stays the guard, since the string comes
 * from the renderer either way.
 */
export async function renameSandbox(base: string, path: string, name: string, owner: SandboxOwner) {
  const plan = planSandboxRename(base, path, name)
  if (!plan.ok) return { ok: false as const, reason: plan.reason }
  // Same folder: a no-op submit, or a rename to the name it already has.
  if (plan.from === plan.to) return { ok: true as const, path: plan.to }
  if (owner.hasLiveFolder(plan.from) || (await owner.hasArchivedFolder(plan.from))) {
    return { ok: false as const, reason: 'in-use' as const }
  }

  // Resolved on either side of the move, and that order matters: every
  // mangling runs on the REAL path, so a source cwd only resolves while the
  // folder is still at `from`, and a destination only once it is at `to`.
  const root = piSessionsRoot(owner.env, owner.home)
  const cwds = [...new Set([...sandboxCwds(plan.from), ...(owner.retainedCwds?.(plan.from) ?? [])])]
  const directories = (paths: readonly string[]) =>
    paths.flatMap((cwd) => [
      sessionDirForCwd(cwd, root),
      claudeProjectDirForCwd(cwd, owner.env, owner.home),
    ])
  const before = directories(cwds)
  const movedCwds = cwds.map((cwd) => rebaseWithinFolder(cwd, plan.from, plan.to))
  if (owner.guardTranscripts) await owner.guardTranscripts(before, directories(movedCwds))
  try {
    await rename(plan.from, plan.to)
  } catch {
    return { ok: false as const, reason: 'failed' as const }
  }
  const after = directories(movedCwds)

  // Best-effort, and after the folder: transcripts left behind cost history,
  // which is worse than the folder not moving but not worth failing over —
  // the folder has already moved and there is nothing to roll back to.
  await Promise.allSettled(before.map((from, index) => moveIfPresent(from, after[index]!)))

  // The cwd each moved transcript stores is still the old one, and pi will
  // not resume a session whose stored cwd is gone. Runs on pi's directories
  // only — the CLI's ledger records a cwd too, but it never refuses a resume
  // over one, and its transcripts are the CLI's file format, not pi's.
  await Promise.all(
    cwds.map((cwd, index) =>
      repointTranscripts(sessionDirForCwd(movedCwds[index]!, root), cwd, movedCwds[index]!, root),
    ),
  )

  owner.repointStoredPaths([
    { from: plan.from, to: plan.to },
    ...before.map((from, index) => ({ from, to: after[index]! })),
  ])
  return { ok: true as const, path: plan.to }
}

/**
 * A sandbox's transcripts go with it. They are scratch chats about a folder
 * that no longer exists, and leaving them behind would hand the next
 * `sandbox-N` — numbers are reused once the folder above them is gone — a
 * sidebar full of somebody else's history.
 *
 * Everything goes to the Trash rather than being unlinked, the same as
 * deleting a session (electron/pi/session-deleter.ts): the user may have
 * written real work into a folder they only meant as scratch.
 *
 * Subtree-wide on both counts, like the rename above: a live lane session
 * blocks the delete (an exact compare let one through, and this one trashes
 * the folder under the running pi), and a lane's transcripts go with it
 * rather than being left behind under a name nothing will ever scan again.
 */
export async function deleteSandbox(base: string, path: string, owner: SandboxOwner) {
  const target = resolveSandboxFolder(base, path)
  if (!target) return { ok: false as const, reason: 'not-a-sandbox' as const }
  if (owner.hasLiveFolder(target) || (await owner.hasArchivedFolder(target))) {
    return { ok: false as const, reason: 'in-use' as const }
  }

  // Resolved before the folder goes: every path mangles the REAL cwd, which
  // is unknowable once the folder is in the Trash.
  const cwds = [...new Set([...sandboxCwds(target), ...(owner.retainedCwds?.(target) ?? [])])]
  const transcripts = cwds.flatMap((cwd) => [
    sessionDirForCwd(cwd, piSessionsRoot(owner.env, owner.home)),
    claudeProjectDirForCwd(cwd, owner.env, owner.home),
  ])
  await owner.guardTranscripts?.(transcripts)
  try {
    await owner.trashItem(target)
  } catch {
    return { ok: false as const, reason: 'failed' as const }
  }
  // Best-effort, and after the folder: a transcript left behind is a worse
  // outcome than the folder surviving, but not one worth failing over.
  await Promise.allSettled(transcripts.map((path) => trashIfPresent(path, owner.trashItem)))

  owner.forgetWorkspace(target)
  return { ok: true as const }
}
