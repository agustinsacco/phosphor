import type { GitInfo, SessionMeta, SessionScanStatus } from '@shared/models'
import { compareSessionsByCreation } from '@shared/session-order'
import { projectPathFor, workspaceName } from '@/lib/path'
import { dropSupersededSessions } from './superseded'

export interface GroupedSessions {
  /**
   * Representative folder for this group: the main repo when it's known,
   * otherwise whichever linked worktree we do know. Used as the persisted
   * collapse key and as the target for group-level actions ("new session
   * here", watchers).
   */
  workspacePath: string
  /** Every physical folder merged into this group (main repo + worktrees). */
  paths: string[]
  name: string
  metas: SessionMeta[]
  liveCount: number
  /** False until every folder in this group has been scanned. */
  scanned: boolean
  /** False until every folder in this group has had at least one scan attempt. */
  attempted: boolean
  /** True when any folder's most recent scan threw. */
  errored: boolean
  /**
   * True once ANY folder in this group has been scanned.
   *
   * The collapse default keys off this rather than `scanned`. A lane
   * (`<repo>/.phosphor/worktrees/<slug>`) is discovered asynchronously and folds
   * into its repo's group, so with `scanned` an already-open group flipped
   * shut the moment discovery added one unscanned folder — which also
   * unwatched it.
   */
  anyScanned: boolean
  /** Folders in this group with no scan attempt yet; drives "loading N more". */
  unscannedPaths: string[]
}

/**
 * Group known workspace folders into one entry per *project*, live projects
 * in the caller's persisted workspace order.
 *
 * A linked worktree is a different folder from its main repo, so grouping
 * naively by folder gave every worktree its own sidebar header ("Phosphor",
 * "Phosphor (test)", ...) even though they're all the same project — the
 * sidebar read as more projects than actually existed. Instead, a worktree's
 * sessions fold into its main repo's group (keyed by `mainRepoPath`, from
 * `git:info`); the worktree/branch a session actually runs on is shown per
 * row via the sidebar's "wt" subtitle chip, not by splitting the group.
 */
export function groupSessionsByProject(
  knownWorkspaces: string[],
  disk: Record<string, SessionMeta[]>,
  gitByCwd: Record<string, GitInfo | undefined>,
  isPinned: (meta: SessionMeta) => boolean,
  isLive: (meta: SessionMeta) => boolean,
  activeWorkspacePath: string,
  /** workspacePath → latest scan attempt; absence = never attempted. */
  scanStatus: Record<string, SessionScanStatus> = {},
  /**
   * worktree folder → the repo `git worktree list` reported it under.
   *
   * The sidebar's discovery pass knows this the instant it learns the path,
   * so a worktree folds into its project on the very first render. Without
   * it, any worktree outside `<repo>/.phosphor/worktrees/` waited on
   * `git:infoBatch` and opened its own branch-named group in the meantime.
   */
  worktreeRoots: Record<string, string> = {},
): GroupedSessions[] {
  const byProject = new Map<
    string,
    {
      paths: string[]
      metas: SessionMeta[]
      liveCount: number
      scanned: boolean
      attempted: boolean
      errored: boolean
      anyScanned: boolean
      unscannedPaths: string[]
    }
  >()
  for (const path of knownWorkspaces) {
    const git = gitByCwd[path]
    // One group per project. Resolved through `projectPathFor` rather than
    // git info alone: a worktree whose `git:infoBatch` answer has not landed
    // would otherwise open its own group, headed by the branch slug.
    // `worktreeRoots` is what makes that true for a worktree living anywhere
    // on disk, not just under `<repo>/.phosphor/worktrees/`.
    const projectKey = projectPathFor(path, git, worktreeRoots[path])
    const metas = dropSupersededSessions(disk[path] ?? [], isLive).filter((m) => !isPinned(m))
    const liveCount = metas.filter(isLive).length
    const scanned = path in disk
    const attempted = path in scanStatus
    const errored = scanStatus[path] === 'error'
    const existing = byProject.get(projectKey)
    if (existing) {
      existing.paths.push(path)
      existing.metas.push(...metas)
      existing.liveCount += liveCount
      existing.scanned &&= scanned
      existing.attempted &&= attempted
      existing.errored ||= errored
      existing.anyScanned ||= scanned
      if (!attempted) existing.unscannedPaths.push(path)
    } else {
      byProject.set(projectKey, {
        paths: [path],
        metas,
        liveCount,
        scanned,
        attempted,
        errored,
        anyScanned: scanned,
        unscannedPaths: attempted ? [] : [path],
      })
    }
  }
  return (
    [...byProject.entries()]
      .map(([projectKey, entry]) => {
        // The main repo path is the natural target for group-level actions
        // (new session, watchers) when we know about it; otherwise fall back
        // to whichever worktree folder we do know.
        const workspacePath = entry.paths.includes(projectKey) ? projectKey : entry.paths[0]!
        return {
          workspacePath,
          paths: entry.paths,
          name: workspaceName(projectKey),
          metas: entry.metas.sort(compareSessionsByCreation),
          liveCount: entry.liveCount,
          scanned: entry.scanned,
          attempted: entry.attempted,
          errored: entry.errored,
          anyScanned: entry.anyScanned,
          unscannedPaths: entry.unscannedPaths,
        }
      })
      // Unscanned workspaces (beyond the boot-scan cap) still get a header —
      // hiding them would make their sessions unreachable until restart.
      // Map insertion order comes from `knownWorkspaces`, the persisted
      // user-defined order. Do not sort by active/live/recent activity here.
      .filter((g) => g.metas.length > 0 || !g.scanned || g.paths.includes(activeWorkspacePath))
  )
}

interface LiveEntry {
  phosphorId: string
  workspacePath: string
  diskPath?: string
}

/**
 * Live sessions with no matching row in `disk` yet, keyed by each session's
 * group. A freshly created session is spawned and prompted immediately,
 * but its `.jsonl` file only appears once pi writes it — and the session-dir
 * watcher adds `awaitWriteFinish` plus a debounce before reporting it.
 * Without these placeholder rows a session you just started shows no row
 * at all until the scan catches up, which reads as a dropped message.
 */
export function pendingSessionsByGroup(
  live: LiveEntry[],
  diskPaths: ReadonlySet<string>,
  groups: Pick<GroupedSessions, 'workspacePath' | 'paths'>[],
): Map<string, string[]> {
  const groupKeyByPath = new Map<string, string>()
  for (const g of groups) {
    for (const path of g.paths) groupKeyByPath.set(path, g.workspacePath)
  }

  const map = new Map<string, string[]>()
  for (const entry of live) {
    if (entry.diskPath && diskPaths.has(entry.diskPath)) continue
    const key = groupKeyByPath.get(entry.workspacePath) ?? entry.workspacePath
    const list = map.get(key)
    if (list) list.push(entry.phosphorId)
    else map.set(key, [entry.phosphorId])
  }
  return map
}
