import { app, BrowserWindow, shell } from 'electron'
import { dirname, join } from 'node:path'
import { existsSync, renameSync } from 'node:fs'
import { registerIpcHandlers } from './ipc'
import { maintenanceScheduler } from './ipc/maintenance-handlers'
import { registry } from './registry'
import { ptyManager } from './pty/pty-manager'
import { disposeConnectorAuth } from './pi/connector-auth'
import { cancelAllLogins } from './pi/login-flow'
import { cancelAllClaudeLogins } from './pi/claude-login'
import { unwatchAll } from './pi/session-watcher'
import { unwatchAllWorkspaces } from './fs/workspace-watcher'
import { startUpdateChecks, stopUpdateChecks } from './updates/updater'
import { applyZoom, hideWindowsForE2E, overlayFor } from './window-chrome'
import { getPrefs } from './store'
import { initDebugLog, log } from './debug-log'
import { registerArtifactScheme, registerArtifactProtocol } from './artifacts/artifact-protocol'
import { externalUrl, isAppNavigation } from './external-links'

const isDev = !!process.env.ELECTRON_RENDERER_URL

// Brand identity when running unpackaged (`npm run dev`): packaged builds get
// name + icon from electron-builder (productName / build/icon.*), but a dev
// run is the stock Electron.app, so macOS shows the Electron dock icon and
// the switcher says "Electron". The dock icon is fixable at runtime; the
// menu-bar/switcher *title* is read from Electron.app's Info.plist and is not
// — only a packaged build shows "Phosphor" there.
app.setName('Phosphor')

// The app was named "pidex" until 2026-09-08, and Electron derives the
// userData directory from the app name — so every existing install keeps its
// prefs, drafts and window state in ".../pidex". Adopt that directory once,
// by rename (same volume, atomic), only when the new one does not exist yet.
// Must run before ANYTHING resolves 'userData'; electron/store.ts constructs
// its store lazily for exactly this kind of pre-ready adjustment.
try {
  const newUserData = app.getPath('userData')
  const legacyUserData = join(dirname(newUserData), 'pidex')
  if (!existsSync(newUserData) && existsSync(legacyUserData)) {
    renameSync(legacyUserData, newUserData)
  }
} catch {
  // A failed migration means first-run defaults, not a broken launch.
}
// Inset artwork on macOS (the dock applies no margin of its own, and the
// full-bleed icon.png rendered larger than every neighbouring icon); linux
// window/taskbar slots want the full-bleed tile.
const devIcon = !app.isPackaged
  ? join(app.getAppPath(), process.platform === 'darwin' ? 'build/icon-dock.png' : 'build/icon.png')
  : undefined

// E2E runs must never touch the developer's real prefs. Tests that need
// state to survive a relaunch (e.g. "reopens the last session") pin the
// directory explicitly; everything else gets a per-pid scratch dir. Gated on
// packaging so the env var cannot redirect a shipped app's user data
// (see ipc/pi-session-handlers.ts:piStubPath).
if (!app.isPackaged && process.env.PHOSPHOR_TEST_USER_DATA) {
  const dir =
    process.env.PHOSPHOR_TEST_USER_DATA !== '1'
      ? process.env.PHOSPHOR_TEST_USER_DATA
      : join(app.getPath('temp'), `phosphor-e2e-${process.pid}`)
  app.setPath('userData', dir)
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // Frameless on every platform. The sidebar and chat header already reserve
    // a 44px drag strip for macOS's traffic lights; leaving Windows/Linux on
    // 'default' stacked a native title bar AND a menu bar on top of that strip,
    // so a third of the window height was chrome. Windows/Linux get no traffic
    // lights, so Electron draws the controls via the Window Controls Overlay
    // (@platform win32,linux) at the same 44px height the strip reserves.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: overlayFor(getPrefs().theme) }),
    // The in-window menu bar duplicated shortcuts already in the palette and
    // cost another row of chrome; Alt still reveals it on Windows/Linux.
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundColor: '#1e1c18', // must equal the dark theme's --px-bg
    // Window/taskbar icon for unpackaged linux runs (packaged linux resolves
    // it from the desktop entry; macOS ignores this option).
    ...(devIcon && process.platform === 'linux' ? { icon: devIcon } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Required whenever the window stays unmapped; see hideWindowsForE2E.
      ...(hideWindowsForE2E() ? { backgroundThrottling: false } : {}),
    },
  })

  window.on('ready-to-show', () => {
    if (!hideWindowsForE2E()) window.show()
  })

  // Chromium resets the zoom factor on every navigation, so the stored UI
  // scale has to be re-applied per load — not once at creation, or an HMR
  // reload (or the packaged app's first paint) silently snaps back to 100%.
  window.webContents.on('did-finish-load', () => applyZoom(getPrefs().fonts.uiScale))

  // External links open in the default browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url)
    if (external) void shell.openExternal(external)
    return { action: 'deny' }
  })

  // Same rule for a link that tries to replace this document instead of
  // opening a window (a plain anchor, a middle-click). The window has one
  // document and no routes, so navigating away is never recoverable in-app.
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppNavigation(url, window.webContents.getURL())) return
    event.preventDefault()
    const external = externalUrl(url)
    if (external) void shell.openExternal(external)
  })

  if (isDev) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL!)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return window
}

/**
 * One Phosphor per machine.
 *
 * Two instances would each own a copy of the session registry, so they would
 * race each other over the same session files. Focusing the existing window is
 * also what a user expects from relaunching.
 *
 * E2E launches deliberately opt out: Playwright drives several app instances,
 * and the lock would make the second one exit instead of starting.
 */
// Must precede app.whenReady(): privileged scheme registration is only read
// during Chromium's startup. See artifacts/artifact-protocol.ts.
registerArtifactScheme()

const singleInstance = process.env.PHOSPHOR_TEST_USER_DATA ? true : app.requestSingleInstanceLock()

if (!singleInstance) {
  // Say so. `npm run dev` against an already-running installed Phosphor exits
  // here with no window and no message — electron-vite prints "starting
  // electron app..." and then nothing forever, which reads as a broken build
  // rather than a lock. That silence cost a debugging session; the workaround
  // is a separate profile via PHOSPHOR_TEST_USER_DATA.
  // Dev only: for a packaged app a second launch is the normal "focus the
  // existing window" path, and the debug log is not open yet here anyway.
  if (!app.isPackaged) {
    console.error(
      'Phosphor is already running, so this instance exited. ' +
        'For a second instance during development, set PHOSPHOR_TEST_USER_DATA to a scratch directory.',
    )
  }
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  app.whenReady().then(() => {
    // First thing after ready: anything that throws below should land in the
    // log rather than only in a terminal nobody was attached to.
    initDebugLog()
    if (devIcon && process.platform === 'darwin') {
      app.dock?.setIcon(devIcon)
    }
    registerArtifactProtocol()
    registerIpcHandlers()
    createWindow()
    // No-op unless packaged: dev and E2E must never poll GitHub.
    startUpdateChecks()
    // Reclaims dead lanes on a timer. Unref'd, warms up before its first
    // sweep, and deletes nothing unless the user turned that on.
    maintenanceScheduler.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // A main-process throw with no listener prints to a terminal that a packaged
  // app does not have. Record it, then leave the default behaviour alone.
  process.on('uncaughtException', (error) => {
    log('main', 'uncaughtException', { message: error.message, stack: error.stack })
  })
  process.on('unhandledRejection', (reason) => {
    log('main', 'unhandledRejection', { reason: String(reason) })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  // Clean shutdown: SIGTERM to every pi child, kill all PTYs, close all
  // filesystem watchers so no chokidar handles or debounce timers outlive us.
  stopUpdateChecks()
  // Before killAll: a login flow polls its own pty on a timer, and killing the
  // pty out from under it would leave that timer running against a dead id.
  cancelAllLogins()
  cancelAllClaudeLogins()
  // A connector flow owns its own throwaway pi child — not in the registry, so
  // disposeAll below would not touch it, and it holds the OAuth callback port.
  disposeConnectorAuth()
  ptyManager.killAll()
  void Promise.allSettled([registry.disposeAll(), unwatchAll(), unwatchAllWorkspaces()]).finally(
    () => app.quit(),
  )
})

/**
 * Teardown for shutdowns Electron does not route through `before-quit`.
 *
 * Synchronous only: by the time these fire the parent is already going away,
 * so an awaited dispose would lose the race. Nothing here writes to disk (pi
 * owns its session files and gets a SIGTERM to flush), and watchers/timers die
 * with the process.
 */
function hardShutdown(): never {
  quitting = true
  try {
    ptyManager.killAll()
    registry.killAllSync()
  } catch {
    // best effort — we are exiting regardless
  }
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (quitting) return
    hardShutdown()
  })
}

/**
 * Dev-only orphan guard: exit when the launcher goes away.
 *
 * `electron-vite dev` kills its Electron child only on rebuild — it installs
 * no exit handler of its own — and the child is not in the terminal's
 * foreground process group, so Ctrl-C kills the CLI and leaves the app
 * running. The dev command appears to hang (prompt returns, app still up,
 * further Ctrl-C does nothing) and the next `npm run dev` fights the orphan
 * for port 5173.
 *
 * Polling `kill(ppid, 0)` is the portable way to notice: no signal is sent,
 * it just throws once that pid is gone. Cheap at 1s, unref'd so it can never
 * itself hold the loop open, and dev-only so packaged builds (where the
 * parent legitimately exits first) are untouched.
 */
if (isDev && !app.isPackaged) {
  const launcherPid = process.ppid
  const orphanCheck = setInterval(() => {
    try {
      process.kill(launcherPid, 0)
    } catch {
      if (!quitting) hardShutdown()
    }
  }, 1000)
  orphanCheck.unref()
}
