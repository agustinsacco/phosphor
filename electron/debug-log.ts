/**
 * On-disk debug log for the main process.
 *
 * Written because a real debugging session had nothing to work from. Every
 * `pi-claude-cli` turn was failing with `Error: Claude CLI returned success`,
 * a message that is self-contradictory and names no cause. The actual reason
 * (`API Error: Effort 'max' isn't available with thinking turned off`) existed
 * only inside the Claude CLI's own transcript under `~/.claude/projects/`.
 * Phosphor had already received the failing turn and kept nothing: pi's stderr
 * was forwarded to the renderer and dropped, and the app wrote no log at all.
 * Reconstructing it took shimming the `claude` binary to capture argv.
 *
 * Deliberately dependency-free and always-on. A log that must be enabled first
 * is never on when the bug happens — the failure has already occurred by the
 * time anyone thinks to look. Cost is bounded by size-capped rotation.
 *
 * NOT for the renderer: it is sandboxed and has no disk access by design.
 * Renderer-side problems surface through DevTools.
 */
import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Rotate at 5MB, keeping one previous file: two rotations bound disk at ~10MB. */
const MAX_BYTES = 5 * 1024 * 1024

let logPath: string | null = null
let failed = false

/** Absolute path of the current log file, or null before init. */
export function debugLogPath(): string | null {
  return logPath
}

/**
 * Resolve the log path and record a session header.
 *
 * Call once from `whenReady` — `app.getPath('logs')` is only meaningful after
 * the app is ready, and main.ts may redirect `userData` before that for E2E.
 */
export function initDebugLog(): void {
  if (logPath || failed) return
  try {
    const dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'phosphor.log')
    log('app', 'session start', {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: `${process.platform}/${process.arch}`,
      packaged: app.isPackaged,
      // The single most useful line when a subprocess "isn't found": a GUI app
      // inherits launchd's PATH, not the login shell's, so `pi` and `claude`
      // may resolve differently here than in a terminal.
      path: process.env.PATH ?? '(unset)',
    })
  } catch {
    // Logging must never take the app down with it.
    failed = true
    logPath = null
  }
}

/**
 * Append one line. Never throws.
 *
 * Synchronous on purpose: a crash-time write has to land before the process
 * goes away, and an async append can lose exactly the line that explains why.
 */
export function log(scope: string, message: string, data?: unknown): void {
  if (!logPath || failed) return
  try {
    rotateIfLarge()
    const extra = data === undefined ? '' : ` ${safeJson(data)}`
    appendFileSync(logPath, `${new Date().toISOString()} [${scope}] ${message}${extra}\n`)
  } catch {
    // Disk full, permissions, a removed directory — all non-fatal here.
  }
}

function rotateIfLarge(): void {
  if (!logPath) return
  try {
    if (statSync(logPath).size < MAX_BYTES) return
    renameSync(logPath, `${logPath}.1`)
  } catch {
    // Missing file is the normal first-write case, not an error.
  }
}

/** Circular structures and bigints must not silently kill a log line. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)) ?? ''
  } catch {
    return '[unserializable]'
  }
}
