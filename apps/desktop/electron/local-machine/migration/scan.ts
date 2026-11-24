import { isWorktreeFolder } from '@phosphor/shared/worktree-segment'
import type { SessionMeta, WorkspaceInfo, WorktreeInfo } from '@phosphor/shared/models'
import { presentSessionFiles, visibleLane, visibleWorktrees } from '@phosphor/shared/visible-lanes'
import type { ArchiveRecord } from '@phosphor/session-runtime/lane-archive/storage'
import type {
  PlanArchiveFact,
  PlanFacts,
  PlanFolderFact,
  PlanPrefs,
  PlanSessionFact,
} from './plan-facts'
import { scanRoutines } from './scan-routines'
import { isDesktopBrainLane } from '../../brain/lane-folder'

/**
 * Step 3's input: what Desktop's sidebar shows today, computed in main the
 * way the renderer computes it (`useKnownWorkspaces`, `useWorktreeDiscovery`,
 * `useLocalSidebarGroups`). The recents (never Desktop's private Brain lane,
 * which stays in-app), realpathed and de-duplicated, then
 * each sandbox; per folder its sessions, its live git worktrees and the
 * retained checkouts of removed ones; rewound predecessors and lanes a
 * routine owns are scanned but not visible. Every disk read is a port.
 */

export interface ScanPorts {
  readonly migrationId: string
  readonly machineId: string
  readonly userData: string
  readonly backupDir: string
  readonly prefs: PlanPrefs & { readonly recentWorkspaces: readonly WorkspaceInfo[] }
  /** `<userData>/sandboxes`, realpathed. */
  readonly sandboxBase: string
  readonly sandboxes: () => readonly { path: string; name: string }[]
  readonly realpath: (path: string) => string | null
  readonly listSessions: (folder: string) => Promise<readonly SessionMeta[]>
  readonly listWorktrees: (repo: string) => Promise<readonly WorktreeInfo[]>
  readonly retainedWorkspaces: (repo: string) => Promise<readonly string[]>
  readonly archives: () => Promise<readonly ArchiveRecord[]>
  readonly exists: (path: string) => boolean
  /** Bytes, or 0 when it cannot be read. */
  readonly size: (path: string) => number
  /** The backup's consistent routines copy, or null when This Mac has none. */
  readonly routinesCopy: string | null
}

interface FolderScan {
  readonly folders: PlanFolderFact[]
  readonly folderRealpaths: Record<string, string>
  readonly duplicateFolders: string[]
}

/** The recents (worktree folders never are), then each sandbox not already listed. */
export function scanFolders(ports: ScanPorts): FolderScan {
  const folders: PlanFolderFact[] = []
  const folderRealpaths: Record<string, string> = {}
  const duplicateFolders: string[] = []
  const seen = new Set<string>()
  const add = (path: string, name: string, sandbox: boolean) => {
    const real = ports.realpath(path) ?? path
    folderRealpaths[path] = real
    if (seen.has(real)) {
      duplicateFolders.push(path)
      return
    }
    seen.add(real)
    folders.push({ path: real, name, sandbox })
  }
  const insideSandboxes = (path: string) => path.startsWith(`${ports.sandboxBase}/`)
  for (const recent of ports.prefs.recentWorkspaces)
    if (
      !isWorktreeFolder(recent.path) &&
      !isDesktopBrainLane(recent.path, ports.userData, ports.realpath)
    ) {
      const real = ports.realpath(recent.path) ?? recent.path
      add(recent.path, recent.name, insideSandboxes(real))
    }
  for (const sandbox of ports.sandboxes()) {
    const real = ports.realpath(sandbox.path) ?? sandbox.path
    if (!seen.has(real)) add(sandbox.path, sandbox.name, true)
  }
  return { folders, folderRealpaths, duplicateFolders: [...new Set(duplicateFolders)] }
}

interface ScannedDir {
  readonly dir: string
  readonly root: string
  readonly branch: string | null
}

/** Each folder, then (repositories only) its visible worktrees, as the sidebar discovers them. */
async function sessionDirs(ports: ScanPorts, folders: readonly PlanFolderFact[]) {
  const dirs: ScannedDir[] = []
  const seen = new Set<string>()
  const push = (dir: ScannedDir) => {
    if (seen.has(dir.dir)) return
    seen.add(dir.dir)
    dirs.push(dir)
  }
  for (const folder of folders) {
    push({ dir: folder.path, root: folder.path, branch: null })
    if (folder.sandbox) continue
    const checkouts = await ports.listWorktrees(folder.path).catch(() => [] as WorktreeInfo[])
    const retained = await ports.retainedWorkspaces(folder.path).catch(() => [] as string[])
    const branches = new Map(checkouts.map((w) => [w.realPath || w.path, w.branch]))
    for (const path of visibleWorktrees(retained, checkouts))
      push({ dir: path, root: folder.path, branch: branches.get(path) ?? null })
  }
  return dirs
}

function sessionFact(
  ports: ScanPorts,
  meta: SessionMeta,
  dir: ScannedDir,
  visible: boolean,
  routine: boolean,
): PlanSessionFact {
  return {
    path: meta.path,
    sessionId: meta.sessionId,
    cwd: meta.cwd || dir.dir,
    rootPath: dir.root,
    worktree: dir.dir !== dir.root,
    createdAt: meta.createdAt,
    mtimeMs: meta.mtimeMs,
    lastActivityAt: meta.lastActivityAt,
    ...(meta.name ? { name: meta.name } : {}),
    ...(meta.firstUserText ? { firstUserText: meta.firstUserText } : {}),
    branch: dir.branch,
    size: ports.size(meta.path),
    cwdMissing: !ports.exists(meta.cwd || dir.dir),
    visible,
    routine,
  }
}

/** Every session in the scanned folders, with the sidebar's visibility rule applied. */
export async function scanSessions(
  ports: ScanPorts,
  folders: readonly PlanFolderFact[],
  routineLanes: ReadonlySet<string>,
): Promise<PlanSessionFact[]> {
  const listed: { meta: SessionMeta; dir: ScannedDir }[] = []
  const byDir: Record<string, SessionMeta[]> = {}
  for (const dir of await sessionDirs(ports, folders)) {
    const metas = [...(await ports.listSessions(dir.dir))]
    byDir[dir.dir] = metas
    for (const meta of metas) listed.push({ meta, dir })
  }
  const present = presentSessionFiles(byDir, [])
  const pinned = new Set(ports.prefs.pinnedSessions)
  const seen = new Set<string>()
  const sessions: PlanSessionFact[] = []
  for (const { meta, dir } of listed) {
    if (seen.has(meta.path)) continue
    seen.add(meta.path)
    const routine = routineLanes.has(meta.path)
    const visible =
      !routine &&
      visibleLane(meta.path, ports.prefs.rewoundSessions, present, {
        pinned: pinned.has(meta.path),
      })
    sessions.push(sessionFact(ports, meta, dir, visible, routine))
  }
  return sessions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** The migrated folder an archived lane belongs to: the deepest one holding its folder. */
export function archiveFolder(
  record: ArchiveRecord,
  folders: readonly PlanFolderFact[],
  realpath: (path: string) => string | null,
): string | null {
  const candidates = [record.repository, record.cwd].flatMap((p) =>
    p ? [p, realpath(p) ?? p] : [],
  )
  let best: string | null = null
  for (const folder of folders)
    for (const path of candidates)
      if (
        (path === folder.path || path.startsWith(`${folder.path}/`)) &&
        folder.path.length > (best?.length ?? -1)
      )
        best = folder.path
  return best
}

/** The facts `buildPlan` maps. */
export async function scanPlanFacts(ports: ScanPorts): Promise<PlanFacts> {
  const { folders, folderRealpaths, duplicateFolders } = scanFolders(ports)
  const routines = scanRoutines({
    backupDir: ports.backupDir,
    consistent: ports.routinesCopy,
    realpath: ports.realpath,
  })
  const sessions = await scanSessions(ports, folders, routines?.laneIndex ?? new Set())
  const archives: PlanArchiveFact[] = [...(await ports.archives())]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((record) => ({ record, folder: archiveFolder(record, folders, ports.realpath) }))
  const bindings = ports.prefs.claudeAccounts?.bindings ?? {}
  return {
    migrationId: ports.migrationId,
    machineId: ports.machineId,
    userData: ports.userData,
    prefs: ports.prefs,
    folders,
    folderRealpaths,
    duplicateFolders,
    sessions,
    archives,
    sandboxRoot: folders.some((f) => f.sandbox) ? ports.sandboxBase : null,
    routines: routines?.fact ?? null,
    accountBindings: Object.fromEntries(
      Object.entries(bindings).filter(([sessionFile]) => ports.exists(sessionFile)),
    ),
  }
}
