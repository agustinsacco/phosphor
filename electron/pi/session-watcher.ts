import chokidar, { type FSWatcher } from 'chokidar'
import { mkdirSync, type Stats } from 'node:fs'
import { normalize } from 'node:path'
import { BrowserWindow } from 'electron'
import { sessionDirForCwd } from './session-scanner'

const watchers = new Map<string, FSWatcher>()
const debounceTimers = new Map<string, NodeJS.Timeout>()

/**
 * Files one session directory may hold open. One fd per watched file (see
 * workspace-watcher.ts for the measurement); a workspace with more sessions
 * than this degrades to "new files past the cap don't push", and the sidebar
 * still refreshes on expand/scan.
 */
export const MAX_WATCHED_SESSION_FILES = 2_000

/** Watch a workspace's session dir; broadcasts `sessions:changed` pushes. */
export function watchWorkspaceSessions(workspacePath: string): void {
  if (watchers.has(workspacePath)) return
  const dir = sessionDirForCwd(workspacePath)

  // Create the directory first, or this watcher is born dead. chokidar does
  // not poll for a watch target that does not exist yet: pointed at a missing
  // path it reports `getWatched() === {}` and never fires, even once the path
  // appears (verified against chokidar 4). That is exactly the state a brand-
  // new worktree is in — pi has not written its first session file, so
  // `~/.pi/agent/sessions/--<mangled cwd>--` does not exist — so the session
  // that a chat just started never got a `sessions:changed` push, and its
  // sidebar row sat as a context-menu-less placeholder until some unrelated
  // re-render happened to re-scan the folder.
  //
  // mkdir is safe and non-destructive: pi creates this exact directory itself
  // (same `sessionDirForCwd` mangling), so at worst we create it a second
  // earlier, and an empty dir simply scans to zero sessions.
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Unwritable session root: watching still beats not watching.
  }

  // Bounded like the workspace watcher, and for the same reason: chokidar
  // opens one fd per watched PATH, files included, and `depth: 0` bounds
  // recursion, not file count. Today's busiest session dir here holds 10
  // files, so the cap is pure insurance — but the 2026-08-31 EMFILE incident
  // was precisely a flat directory nobody thought could get big.
  const granted = new Set<string>()
  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    depth: 0,
    ignored: (rawPath: string, stats?: Stats) => {
      const path = normalize(rawPath)
      if (path === normalize(dir)) return false
      if (granted.has(path)) return false
      // Same idempotence contract as createWatchFilter: only stats-carrying
      // calls spend budget, so chokidar's stats-free re-asks neither
      // double-count nor read a full budget as a deletion.
      if (!stats) return granted.size >= MAX_WATCHED_SESSION_FILES
      if (granted.size >= MAX_WATCHED_SESSION_FILES) return true
      granted.add(path)
      return false
    },
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
  })
  watcher.on('unlink', (path) => granted.delete(normalize(path)))
  watcher.on('error', (error) => {
    // Never let a watcher error become an uncaught exception in main.
    console.warn(`[Phosphor] session watcher error for ${dir}:`, error)
  })

  const notify = (): void => {
    const existing = debounceTimers.get(workspacePath)
    if (existing) clearTimeout(existing)
    debounceTimers.set(
      workspacePath,
      setTimeout(() => {
        debounceTimers.delete(workspacePath)
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send('sessions:changed', { workspacePath })
          }
        }
      }, 300),
    )
  }

  watcher.on('add', notify)
  watcher.on('change', notify)
  watcher.on('unlink', notify)
  watchers.set(workspacePath, watcher)
}

/** Stop watching one workspace's session dir (collapsed sidebar groups). */
export async function unwatchWorkspaceSessions(workspacePath: string): Promise<void> {
  const timer = debounceTimers.get(workspacePath)
  if (timer) clearTimeout(timer)
  debounceTimers.delete(workspacePath)
  const watcher = watchers.get(workspacePath)
  watchers.delete(workspacePath)
  await watcher?.close()
}

/** Close every session watcher and cancel pending debounced notifications. */
export async function unwatchAll(): Promise<void> {
  for (const timer of debounceTimers.values()) clearTimeout(timer)
  debounceTimers.clear()
  await Promise.allSettled([...watchers.values()].map((w) => w.close()))
  watchers.clear()
}
