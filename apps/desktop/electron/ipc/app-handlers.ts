import { app, BrowserWindow, dialog, shell } from 'electron'
import { basename } from 'node:path'
import { listSandboxFolders, openSandboxFolder } from '../sandbox'
import { deleteSandbox, renameSandbox, sandboxBase } from '../sandbox-service'
import { pathExists } from '../sandbox-transcripts'
import { registry } from '../registry'
import { syncContextBudget, withBudgetCompaction } from '../pi/context-budget'
import { piStubPath } from '../pi/stub'
import { setLaneContextFile } from '../pi/context-files'
import { isRoutineSession } from '../routines/ownership'
import { handle } from './handle'
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
import {
  saveComposerDraft,
  clearComposerDraft,
  writeComposerDraftBlob,
  sweepComposerDrafts,
} from '../app/draft-service'
import { resolveResumeTarget } from '../app/resume-target'
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
  setRewoundSessions,
  setSessionOrder,
  setRecentWorkspaces,
  setTheme,
  setAgentDirectives,
  clearRetiredDirectives,
  setWorktreePrefs,
  setContextBudget,
  setContextFile,
  setDraft,
  clearDraft,
  setDrafts,
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

/** App preferences, native dialogs, and runtime info. */
export function registerAppHandlers(): void {
  registerPreferenceHandlers()
  registerContextHandlers()
  registerDraftHandlers()
  registerRuntimeHandlers()
  registerDialogHandlers()
  registerSandboxHandlers()
}

function registerPreferenceHandlers(): void {
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

  handle('app:setPinnedSessions', (_event, paths) => setPinnedSessions(paths))

  handle('app:setRewoundSessions', (_event, record) => setRewoundSessions(record))

  handle('app:setLanePrefs', (_event, lanes) => setLanePrefs(lanes))

  handle('app:setLaneMarkers', (_event, markers) => setLaneMarkers(markers))

  handle('app:setModelPicks', (_event, picks) => setModelPicks(picks))

  handle('app:setLastSession', (_event, sessionPath) => setLastSession(sessionPath))

  handle('app:setCollapsedWorkspaces', (_event, paths) => setCollapsedWorkspaces(paths))

  handle('app:recordWorkspace', (_event, path: string) => {
    recordWorkspace(path, basename(path))
  })

  handle('app:setFontPrefs', (_event, fonts) => {
    setFontPrefs(fonts)
    // UI scale is page zoom (see window-chrome.applyZoom); it has to be stored
    // before this call, which reads the prefs back to resize the OS overlay.
    applyZoom(fonts.uiScale)
  })

  handle('app:setRecentWorkspaces', (_event, workspaces) => setRecentWorkspaces(workspaces))

  handle('app:setWorktreePrefs', (_event, worktrees) => setWorktreePrefs(worktrees))

  handle('app:setAgentDirectives', (_event, directives, projectPath) =>
    setAgentDirectives(directives, projectPath),
  )

  handle('app:clearRetiredDirectives', () => clearRetiredDirectives())

  handle('app:markSessionSeen', (_event, sessionPath: string) => {
    markSessionSeen(sessionPath)
  })
}

function registerContextHandlers(): void {
  handle('app:setContextBudget', async (_event, value: string) => {
    setContextBudget(value)
    if (piStubPath()) return
    await Promise.all(
      registry.list().map(({ sessionId }) =>
        withBudgetCompaction(sessionId, 'prompt', async () => {
          const session = registry.get(sessionId)
          if (session) await syncContextBudget(session.client, getPrefs().contextBudget)
        }),
      ),
    )
  })

  handle('app:setContextFile', (_event, kind, included: boolean, sessionId?: string) =>
    setLaneContextFile(
      {
        save: setContextFile,
        isStub: () => Boolean(piStubPath()),
        ownedByRoutine: isRoutineSession,
        session: (id) => registry.get(id),
      },
      kind,
      included,
      sessionId,
    ),
  )
}

function registerRuntimeHandlers(): void {
  handle('app:resumeTarget', () => resolveResumeTarget(getPrefs(), pathExists))
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
}

function registerDialogHandlers(): void {
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

function registerSandboxHandlers(): void {
  handle('app:createSandbox', () => openSandboxFolder(sandboxBase()))

  handle('app:listSandboxes', () => listSandboxFolders(sandboxBase()))

  handle('app:renameSandbox', (_event, path, name) => renameSandbox(path, name))
  handle('app:deleteSandbox', (_event, path) => deleteSandbox(path))
}

function registerDraftHandlers(): void {
  const deps = () => ({
    getDrafts: () => getPrefs().drafts,
    setDraft,
    clearDraft,
    setDrafts,
    deleteBlobs: deleteDraftBlobs,
    listBlobs: listDraftBlobs,
    writeBlob: writeDraftBlob,
    wouldExceedBlobCap,
    pathExists,
  })
  handle('app:setDraft', (_event, draft) => saveComposerDraft(deps(), draft))
  handle('app:clearDraft', (_event, key) => clearComposerDraft(deps(), key))
  handle('app:writeDraftBlob', (_event, blobId, base64) =>
    writeComposerDraftBlob(deps(), blobId, base64),
  )
  handle('app:readDraftBlob', (_event, blobId) => readDraftBlob(blobId))
  handle('app:sweepDrafts', () => sweepComposerDrafts(deps()))
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
