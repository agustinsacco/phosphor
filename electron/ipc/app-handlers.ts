import { app, BrowserWindow, dialog, shell } from 'electron'
import { basename, join } from 'node:path'
import { listSandboxFolders, openSandboxFolder, resolveSandboxFolder } from '../sandbox'
import { access } from 'node:fs/promises'
import { claudeProjectDirForCwd, sessionDirForCwd } from '../pi/pi-paths'
import { registry } from '../registry'
import { handle } from './handle'
import { stageArtifactHtml } from '../artifacts/artifact-protocol'
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
  setRecentWorkspaces,
  setTheme,
  setAgentDirectives,
  setWorktreePrefs,
  setClaudeAutocompact,
  setDraft,
  clearDraft,
  setDrafts,
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
 */
function sandboxBase(): string {
  return join(app.getPath('userData'), 'sandboxes')
}

/** Trash a path if it is there — a missing one is not an error here. */
async function trashIfPresent(path: string): Promise<void> {
  if (!(await pathExists(path))) return
  await shell.trashItem(path)
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

  handle('app:setPinnedSessions', (_event, paths) => {
    setPinnedSessions(paths)
  })

  handle('artifacts:stageHtml', (_event, html, theme) => stageArtifactHtml(html, theme))

  handle(
    'artifacts:exportPdf',
    async (
      _event,
      payload: {
        content: string
        type: string
        title: string
        language?: string
        theme?: 'light' | 'dark'
      },
    ) => {
      const { content, type, title, language, theme = 'dark' } = payload
      const downloadsDir = app.getPath('downloads')
      const safeTitle = title.replace(/[^a-z0-9-]/gi, '-').slice(0, 60) || 'artifact'
      const filePath = join(downloadsDir, `${safeTitle}.pdf`)
      const skeletonCss = `
      :root { color-scheme: dark; --art-bg: #0e0d0b; --art-panel: #14120f; --art-panel-2: #191713; --art-line: #2b2621; --art-line-soft: #201d18; --art-ink: #f1ede5; --art-ink-2: #a7a096; --art-ink-3: #6e6961; --art-accent: #f2ab4e; --art-accent-dim: #2a1f10; --art-sans: -apple-system, "Segoe UI", system-ui, sans-serif; --art-mono: ui-monospace, "SF Mono", Menlo, monospace; }
      @media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { color-scheme: light; --art-bg: #f6f5f2; --art-panel: #fff; --art-panel-2: #faf9f6; --art-line: #dedad2; --art-line-soft: #ebe8e1; --art-ink: #15130f; --art-ink-2: #55514a; --art-ink-3: #8b867d; --art-accent: #b26a12; --art-accent-dim: #f7eddc; } }
      :root[data-theme="light"] { color-scheme: light; --art-bg: #f6f5f2; --art-panel: #fff; --art-panel-2: #faf9f6; --art-line: #dedad2; --art-line-soft: #ebe8e1; --art-ink: #15130f; --art-ink-2: #55514a; --art-ink-3: #8b867d; --art-accent: #b26a12; --art-accent-dim: #f7eddc; }
      * { box-sizing: border-box; }
      body { margin: 0; padding: clamp(1.5rem, 4vw, 3rem); background: var(--art-bg); color: var(--art-ink); font-family: var(--art-sans); font-size: 15px; line-height: 1.5; }
      .wrap { max-width: 62rem; margin: 0 auto; }
      h1, h2, h3, h4 { margin: 0; font-weight: 650; letter-spacing: -0.015em; }
      h1 { font-size: clamp(1.8rem, 5vw, 2.6rem); line-height: 1.1; margin-bottom: 0.75rem; }
      h2 { font-size: 1.2rem; margin-top: 2rem; }
      h3 { font-size: 1.05rem; margin-top: 1.5rem; }
      p { margin: 0 0 0.8rem; }
      a { color: var(--art-accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      ul, ol { margin: 0.5rem 0 1rem; padding-left: 1.3rem; color: var(--art-ink-2); }
      li { margin-bottom: 0.3rem; }
      hr { border: 0; border-top: 1px solid var(--art-line); margin: 2rem 0; }
      pre { background: var(--art-panel-2); border: 1px solid var(--art-line); border-radius: 4px; padding: 1rem 1.2rem; overflow-x: auto; font-family: var(--art-mono); font-size: 12.5px; line-height: 1.5; color: var(--art-ink-2); }
      pre b, pre strong { color: var(--art-ink); }
      code { font-family: var(--art-mono); font-size: 0.88em; }
      .callout { border-left: 3px solid var(--art-accent); background: var(--art-accent-dim); padding: 0.75rem 1rem; border-radius: 0 4px 4px 0; margin: 1rem 0; }
      img, svg, video { max-width: 100%; height: auto; display: block; }
      .center { display: flex; justify-content: center; align-items: center; min-height: 85vh; }
      .center-content { max-width: 100%; }
      table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
      th, td { padding: 0.5rem 0.6rem; text-align: left; border-bottom: 1px solid var(--art-line-soft); }
      th { font-family: var(--art-mono); font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--art-ink-3); }
      blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 2px solid var(--art-line); color: var(--art-ink-2); }
    `
      function escapeHtml(str: string): string {
        return str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
      }
      let htmlContent: string
      let extraHead = ''
      let extraBody = ''
      switch (type) {
        case 'html':
          htmlContent = `<div class="wrap">${content}</div>`
          break
        case 'svg':
          htmlContent = `<div class="center"><div class="center-content">${content}</div></div>`
          break
        case 'markdown': {
          // Put raw markdown in a hidden textarea so textContent returns it unmodified.
          const escapedForTextArea = content.replace(/<\/textarea>/gi, '&lt;/textarea&gt;')
          htmlContent = `<div class="wrap"><h1>${escapeHtml(title)}</h1><textarea id="md-source" style="display:none;">${escapedForTextArea}</textarea><div id="md-output"></div></div>`
          extraHead = `<script src="https://cdn.jsdelivr.net/npm/marked@14/marked.min.js"></script>`
          extraBody = `<script>document.getElementById('md-output').innerHTML = marked.parse(document.getElementById('md-source').value);</script>`
          break
        }
        case 'mermaid': {
          const escaped = escapeHtml(content)
          htmlContent = `<div class="wrap"><h1>${escapeHtml(title)}</h1><pre class="mermaid">${escaped}</pre></div>`
          extraHead = `<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>`
          extraBody = `<script>mermaid.init({startOnLoad:true,theme:'dark'});</script>`
          break
        }
        case 'chart': {
          const escaped = escapeHtml(content)
          htmlContent = `<div class="wrap"><h1>${escapeHtml(title)}</h1><div class="callout"><strong>Chart specification</strong> (JSON)</div><pre>${escaped}</pre></div>`
          break
        }
        case 'code':
        default: {
          const langLabel = language
            ? ` · <span style="font-family:var(--art-mono);font-size:11px;color:var(--art-ink-3);">${escapeHtml(language)}</span>`
            : ''
          htmlContent = `<div class="wrap"><h1>${escapeHtml(title)}${langLabel}</h1><pre><code>${escapeHtml(content)}</code></pre></div>`
          break
        }
      }
      const fullHtml = `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${skeletonCss}</style>${extraHead}</head><body>${htmlContent}${extraBody}</body></html>`
      const win = new BrowserWindow({
        show: false,
        width: 1200,
        height: 900,
        webPreferences: { contextIsolation: true, sandbox: false },
      })
      const encoded = encodeURIComponent(fullHtml)
      await win.loadURL(`data:text/html;charset=utf-8,${encoded}`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000)
        win.webContents.once('did-finish-load', () => {
          clearTimeout(timer)
          setTimeout(resolve, 800)
        })
      })
      let scrollHeight = 1200
      try {
        const measured = await win.webContents.executeJavaScript(
          `Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.offsetHeight, document.documentElement.offsetHeight, document.body.clientHeight, document.documentElement.clientHeight)`,
        )
        scrollHeight = Math.max(Number(measured) || 1200, 900)
      } catch {
        // Fallback: measurement failed; use fixed long page height.
      }
      const heightInches = Math.min(Math.max(scrollHeight / 96 + 1.5, 11), 200)
      const pdfData = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: 8.5, height: heightInches },
        margins: { marginType: 'none' },
        preferCSSPageSize: false,
      })
      win.destroy()
      const fs = await import('node:fs/promises')
      await fs.writeFile(filePath, pdfData)
      return { savedTo: filePath }
    },
  )

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
    const override = e2eWorkspaceOverride()
    if (override) return override
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open Workspace Folder',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })

  handle('app:createSandbox', () => openSandboxFolder(sandboxBase()))

  handle('app:listSandboxes', () => listSandboxFolders(sandboxBase()))

  /**
   * A sandbox's transcripts go with it. They are scratch chats about a folder
   * that no longer exists, and leaving them behind would hand the next
   * `sandbox-N` — numbers are reused once the folder above them is gone — a
   * sidebar full of somebody else's history.
   *
   * Everything goes to the Trash rather than being unlinked, the same as
   * deleting a session (electron/pi/session-deleter.ts): the user may have
   * written real work into a folder they only meant as scratch.
   */
  handle('app:deleteSandbox', async (_event, path: string) => {
    const target = resolveSandboxFolder(sandboxBase(), path)
    if (!target) return { ok: false as const, reason: 'not-a-sandbox' as const }
    if (registry.list().some((session) => session.workspacePath === target)) {
      return { ok: false as const, reason: 'in-use' as const }
    }

    // Resolved before the folder goes: both paths mangle the REAL cwd, which
    // is unknowable once the folder is in the Trash.
    const transcripts = [sessionDirForCwd(target), claudeProjectDirForCwd(target)]
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
