import { app, BrowserWindow, dialog, shell } from 'electron'
import { basename, join } from 'node:path'
import {
  listSandboxFolders,
  openSandboxFolder,
  planSandboxRename,
  resolveSandboxFolder,
  sandboxCwds,
} from '../sandbox'
import { isWithinFolder, rebaseWithinFolder } from '@shared/paths'
import { access, rename } from 'node:fs/promises'
import { claudeProjectDirForCwd, sessionDirForCwd } from '../pi/pi-paths'
import { registry } from '../registry'
import { handle } from './handle'
import { stageArtifactHtml } from '../artifacts/artifact-protocol'
import { exportArtifactPdf } from '../artifacts/artifact-pdf'
import { applyThemeSource, applyTitleBarOverlay, applyZoom } from '../window-chrome'
import { debugLogPath } from '../debug-log'
import { externalUrl } from '../external-links'
import { userInfo } from 'node:os'
import {
  deleteDraftBlobs,
  listDraftBlobs,
  readDraftBlob,
  wouldExceedBlobCap,
  writeDraftBlob,
} from '../drafts-blobs'
import { orphanBlobIds, sweepDrafts } from '../prefs-utils'
import {
  getPrefs,
  markSessionSeen,
  recordWorkspace,
  setCollapsedWorkspaces,
  setFontPrefs,
  setLastSession,
  setModelPicks,
  setLaneMarkers,
  setLanePrefs,
  setPinnedSessions,
  setSessionOrder,
  setRecentWorkspaces,
  setTheme,
  setAgentDirectives,
  setWorktreePrefs,
  setClaudeAutocompact,
  setDraft,
  clearDraft,
  setDrafts,
  repointStoredPaths,
  realPathOrNull,
} from '../store'

/**
 * E2E hook: skip the native (undriveable) folder picker.
 *
 * Gated on `!app.isPackaged` for the same reason as PHOSPHOR_PI_STUB — a shipped
 * app must not let an environment variable choose the workspace.
 */
function e2eWorkspaceOverride(): string | undefined {
  if (app.isPackaged) return undefined
  return process.env.PHOSPHOR_E2E_WORKSPACE || undefined
}

/** The native folder dialog, or null when dismissed. */
async function pickFolder(event: Electron.IpcMainInvokeEvent): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(window!, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Open Workspace Folder',
  })
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

/** True when the path is reachable — used to validate persisted locations. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Where sandboxes live. userData, not homedir: E2E redirects userData
 * (PHOSPHOR_TEST_USER_DATA), so stub-driven runs never touch the real one.
 *
 * Resolved, so every sandbox path Phosphor hands out is the one pi will derive
 * its session directory from. A userData directory reached through a symlink
 * otherwise yields a second spelling of each sandbox, and the sidebar shows
 * one folder as two groups listing the same lanes.
 */
function sandboxBase(): string {
  const base = join(app.getPath('userData'), 'sandboxes')
  return realPathOrNull(base) ?? base
}

/** Trash a path if it is there — a missing one is not an error here. */
async function trashIfPresent(path: string): Promise<void> {
  if (!(await pathExists(path))) return
  await shell.trashItem(path)
}

/**
 * Move a transcript directory alongside its sandbox.
 *
 * A sandbox with no chats yet simply has no such directory, so a missing
 * source is normal. An occupied destination is left alone rather than merged:
 * it means history already exists under the new name (a sandbox that once had
 * it was deleted or renamed away), and `rename` onto a non-empty directory
 * fails anyway. The old transcripts stay where they are — orphaned, but not
 * destroyed.
 */
async function moveIfPresent(from: string, to: string): Promise<void> {
  if (!(await pathExists(from))) return
  if (await pathExists(to)) return
  await rename(from, to)
}

/** App preferences, native dialogs, and runtime info. */
export function registerAppHandlers(): void {
  handle('app:getPrefs', () => getPrefs())

  handle('app:setTheme', (_event, theme) => {
    setTheme(theme)
    // The OS-drawn window controls do not follow the page theme on their own.
    applyTitleBarOverlay(theme)
    // Neither does an artifact iframe: it is its own document on its own
    // origin, and reads Chromium's scheme rather than the app's theme class.
    applyThemeSource(theme)
  })

  handle('app:setSessionOrder', (_event, paths) => setSessionOrder(paths))

  handle('app:setPinnedSessions', (_event, paths) => {
    setPinnedSessions(paths)
  })

  handle('artifacts:stageHtml', (_event, html, theme) => stageArtifactHtml(html, theme))

  handle('artifacts:exportPdf', (_event, request) => exportArtifactPdf(request))

  handle('app:setLanePrefs', (_event, lanes) => {
    setLanePrefs(lanes)
  })

  handle('app:setLaneMarkers', (_event, markers) => {
    setLaneMarkers(markers)
  })

  handle('app:setModelPicks', (_event, picks) => {
    setModelPicks(picks)
  })

  handle('app:setLastSession', (_event, sessionPath) => {
    setLastSession(sessionPath)
  })

  handle('app:setCollapsedWorkspaces', (_event, paths) => {
    setCollapsedWorkspaces(paths)
  })

  handle('app:recordWorkspace', (_event, path: string) => {
    recordWorkspace(path, basename(path))
  })

  handle('app:setDraft', async (_event, draft) => {
    // Anything the prune dropped takes its images with it.
    await deleteDraftBlobs(setDraft(draft))
  })

  handle('app:clearDraft', async (_event, key) => {
    await deleteDraftBlobs(clearDraft(key))
  })

  handle('app:writeDraftBlob', async (_event, blobId, base64) => {
    // Refuse rather than silently drop: the composer says so out loud.
    const bytes = Math.floor((base64.length * 3) / 4)
    if (await wouldExceedBlobCap(bytes)) return false
    await writeDraftBlob(blobId, base64)
    return true
  })

  handle('app:readDraftBlob', (_event, blobId) => readDraftBlob(blobId))

  handle('app:sweepDrafts', async () => {
    const drafts = getPrefs().drafts
    // Resolve existence up front: `sweepDrafts` is pure so it can be tested
    // without a filesystem.
    const folders = [...new Set(Object.keys(drafts).filter((k) => k.startsWith('home:')))].map(
      (k) => k.slice('home:'.length),
    )
    const alive = new Set(
      (await Promise.all(folders.map(async (f) => ((await pathExists(f)) ? f : null)))).filter(
        (f): f is string => f !== null,
      ),
    )
    const swept = sweepDrafts(drafts, (path) => alive.has(path))
    setDrafts(swept.drafts)
    const orphans = orphanBlobIds(swept.drafts, await listDraftBlobs())
    await deleteDraftBlobs([...swept.dropped, ...orphans])
    return swept.drafts
  })

  handle('app:resumeTarget', async () => {
    const { lastSessionPath, lastWorkspacePath, recentWorkspaces } = getPrefs()

    // Prefer the exact session, but only if BOTH it and its workspace still
    // exist — a session file whose folder was deleted can't be resumed.
    if (lastSessionPath && lastWorkspacePath) {
      const [sessionOk, workspaceOk] = await Promise.all([
        pathExists(lastSessionPath),
        pathExists(lastWorkspacePath),
      ])
      if (sessionOk && workspaceOk) {
        return {
          kind: 'session' as const,
          sessionPath: lastSessionPath,
          workspacePath: lastWorkspacePath,
        }
      }
    }

    if (lastWorkspacePath && (await pathExists(lastWorkspacePath))) {
      return { kind: 'workspace' as const, workspacePath: lastWorkspacePath }
    }

    // Fall back to the newest recent that still exists — the picker should
    // only ever appear on a true first run, not because lastWorkspacePath
    // went stale or was never written.
    for (const ws of [...recentWorkspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)) {
      if (await pathExists(ws.path)) {
        return { kind: 'workspace' as const, workspacePath: ws.path }
      }
    }

    return { kind: 'none' as const }
  })

  handle('app:setFontPrefs', (_event, fonts) => {
    setFontPrefs(fonts)
    // UI scale is page zoom (see window-chrome.applyZoom); it has to be stored
    // before this call, which reads the prefs back to resize the OS overlay.
    applyZoom(fonts.uiScale)
  })

  handle('app:setRecentWorkspaces', (_event, workspaces) => {
    setRecentWorkspaces(workspaces)
  })

  handle('app:setWorktreePrefs', (_event, worktrees) => {
    setWorktreePrefs(worktrees)
  })

  handle('app:setAgentDirectives', (_event, directives, projectPath) => {
    setAgentDirectives(directives, projectPath)
  })

  handle('app:setClaudeAutocompact', (_event, value: string) => {
    setClaudeAutocompact(value)
  })

  handle('app:markSessionSeen', (_event, sessionPath: string) => {
    markSessionSeen(sessionPath)
  })

  handle('app:userInfo', () => ({
    username: userInfo().username,
    // Only the profile NAME, never credentials — used to build the right
    // `aws sso login --profile …` suggestion when a token expires.
    awsProfile: process.env.AWS_PROFILE || undefined,
  }))

  handle('app:about', () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  }))

  handle('app:selectFolder', async (event) => {
    // E2E hook: avoid the native (undriveable) dialog.
    const picked = e2eWorkspaceOverride() ?? (await pickFolder(event))
    if (!picked) return null
    // Resolved here, at the place a folder enters Phosphor by hand — the
    // override included, since a temp dir is itself symlinked on macOS.
    // Picking a project through a symlink (a linked checkout, a synced folder)
    // is how a workspace acquires a second spelling, and two spellings are two
    // sidebar groups over one set of sessions.
    return realPathOrNull(picked) ?? picked
  })

  handle('app:createSandbox', () => openSandboxFolder(sandboxBase()))

  handle('app:listSandboxes', () => listSandboxFolders(sandboxBase()))

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
  handle('app:renameSandbox', async (_event, path: string, name: string) => {
    const plan = planSandboxRename(sandboxBase(), path, name)
    if (!plan.ok) return { ok: false as const, reason: plan.reason }
    // Same folder: a no-op submit, or a rename to the name it already has.
    if (plan.from === plan.to) return { ok: true as const, path: plan.to }
    if (registry.list().some((session) => isWithinFolder(session.workspacePath, plan.from))) {
      return { ok: false as const, reason: 'in-use' as const }
    }

    // Resolved on either side of the move, and that order matters: every
    // mangling runs on the REAL path, so a source cwd only resolves while the
    // folder is still at `from`, and a destination only once it is at `to`.
    const cwds = sandboxCwds(plan.from)
    const before = cwds.flatMap((cwd) => [sessionDirForCwd(cwd), claudeProjectDirForCwd(cwd)])
    try {
      await rename(plan.from, plan.to)
    } catch {
      return { ok: false as const, reason: 'failed' as const }
    }
    const after = cwds
      .map((cwd) => rebaseWithinFolder(cwd, plan.from, plan.to))
      .flatMap((cwd) => [sessionDirForCwd(cwd), claudeProjectDirForCwd(cwd)])

    // Best-effort, and after the folder: transcripts left behind cost history,
    // which is worse than the folder not moving but not worth failing over —
    // the folder has already moved and there is nothing to roll back to.
    await Promise.allSettled(before.map((from, index) => moveIfPresent(from, after[index]!)))

    repointStoredPaths([
      { from: plan.from, to: plan.to },
      ...before.map((from, index) => ({ from, to: after[index]! })),
    ])
    return { ok: true as const, path: plan.to }
  })

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
  handle('app:deleteSandbox', async (_event, path: string) => {
    const target = resolveSandboxFolder(sandboxBase(), path)
    if (!target) return { ok: false as const, reason: 'not-a-sandbox' as const }
    if (registry.list().some((session) => isWithinFolder(session.workspacePath, target))) {
      return { ok: false as const, reason: 'in-use' as const }
    }

    // Resolved before the folder goes: every path mangles the REAL cwd, which
    // is unknowable once the folder is in the Trash.
    const transcripts = sandboxCwds(target).flatMap((cwd) => [
      sessionDirForCwd(cwd),
      claudeProjectDirForCwd(cwd),
    ])
    try {
      await shell.trashItem(target)
    } catch {
      return { ok: false as const, reason: 'failed' as const }
    }
    // Best-effort, and after the folder: a transcript left behind is a worse
    // outcome than the folder surviving, but not one worth failing over.
    await Promise.allSettled(transcripts.map(trashIfPresent))

    setRecentWorkspaces(getPrefs().recentWorkspaces.filter((w) => w.path !== target))
    return { ok: true as const }
  })

  handle('app:saveDialog', async (event, options) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(window!, {
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
    })
    return result.canceled ? null : (result.filePath ?? null)
  })

  handle('app:revealPath', (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  // http(s) only, via the shared policy in external-links.ts: a URL string
  // from the renderer must never be able to launch file:// or a registered
  // custom scheme. Every markdown link the model writes arrives here.
  handle('app:openExternal', async (_event, url: string) => {
    const external = externalUrl(url)
    if (external) await shell.openExternal(external)
  })
}

/**
 * Debug-log access.
 *
 * Registered here rather than behind a dev flag: the log exists to explain a
 * failure that already happened, so the path must be reachable from a shipped
 * build without first turning something on.
 */
export function registerDebugLogHandlers(): void {
  handle('app:debugLogPath', () => debugLogPath())
  handle('app:revealDebugLog', () => {
    const path = debugLogPath()
    if (path) shell.showItemInFolder(path)
  })
}
