import { spawn, type IPty } from 'node-pty'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { BrowserWindow } from 'electron'
import { isBusy } from './busy'
import { ensureSpawnHelperExecutable } from './spawn-helper'
import { errorText } from '@shared/errors'

/**
 * Replayed to a reattaching xterm so closing and reopening the pane doesn't
 * show a blank rectangle in front of a live shell. Capped per PTY: a `npm
 * run build` can emit megabytes, and this is scrollback, not a transcript.
 */
const SCROLLBACK_LIMIT = 256 * 1024

interface PtySession {
  ptyId: string
  pty: IPty
  workspacePath: string
  shellName: string
  busy: boolean
  /** Recent output, replayed on reattach (see SCROLLBACK_LIMIT). */
  scrollback: string
  /**
   * Owning chat session, when the caller knows it. Lets the resource monitor
   * charge a terminal's process tree (builds, tests, dev servers) to the right
   * session — that mapping otherwise lives only in the renderer's store.
   */
  sessionId?: string
}

/** Real PTYs (user shell), independent from the agent's bash tool. */
class PtyManager {
  private readonly sessions = new Map<string, PtySession>()
  private pollTimer: NodeJS.Timeout | null = null
  private helperChecked = false

  create(
    workspacePath: string,
    cols: number,
    rows: number,
    sessionId?: string,
    /**
     * Run this instead of the user's shell. Used by the accounts tab to host
     * pi's own interactive `/login`, which exists nowhere else — pi's RPC
     * protocol has no auth command and `/login` is TUI-only. `env` is merged
     * over the inherited environment, because pi needs the login shell's PATH
     * to find node under a version manager.
     */
    command?: { file: string; args: string[]; env?: NodeJS.ProcessEnv },
  ): { ptyId: string } {
    const ptyId = randomUUID()
    const shell = defaultShell()
    const file = command?.file ?? shell.command
    const args = command?.args ?? shell.args

    // Lazy + once: a few stats, and they only matter on the first spawn.
    if (!this.helperChecked) {
      this.helperChecked = true
      ensureSpawnHelperExecutable()
    }

    let pty: IPty
    try {
      pty = spawn(file, args, {
        name: 'xterm-256color',
        cwd: workspacePath,
        cols,
        rows,
        env: { ...process.env, ...command?.env, TERM_PROGRAM: 'phosphor' } as Record<
          string,
          string
        >,
      })
    } catch (error) {
      // node-pty throws bare strings like "posix_spawnp failed." with no hint
      // of which of the half-dozen causes applied. Re-throw with context so
      // the renderer can show something actionable instead of hanging on
      // "Starting shell…" forever.
      throw new Error(describeSpawnFailure(error, file, workspacePath), { cause: error })
    }

    pty.onData((data) => {
      const session = this.sessions.get(ptyId)
      if (session) {
        const next = session.scrollback + data
        session.scrollback =
          next.length > SCROLLBACK_LIMIT ? next.slice(next.length - SCROLLBACK_LIMIT) : next
      }
      broadcast(`pty:data:${ptyId}`, data)
    })

    pty.onExit(({ exitCode }) => {
      this.sessions.delete(ptyId)
      this.syncPolling()
      broadcast(`pty:exit:${ptyId}`, exitCode)
    })

    this.sessions.set(ptyId, {
      ptyId,
      pty,
      workspacePath,
      shellName: basename(file),
      busy: false,
      scrollback: '',
      sessionId,
    })
    this.syncPolling()
    return { ptyId }
  }

  /**
   * True when any live shell belongs to this chat session. The idle-session
   * reaper must not reclaim a session whose terminal may be running a build —
   * artifacts and layout rebuild on resume, a killed shell command does not.
   */
  hasLiveForSession(sessionId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) return true
    }
    return false
  }

  /**
   * Scrollback for a reattaching view. Unknown ptyId yields '' so a stale
   * renderer reattaching to a dead shell is a no-op, not a throw.
   *
   * The ordering in `onData` is load-bearing: it appends to `scrollback`
   * *before* broadcasting, so this snapshot is a superset of everything the
   * caller already received on `pty:data:<id>`. A reattaching view can
   * therefore discard what it buffered while this call was in flight rather
   * than trying to de-duplicate a byte stream.
   */
  attach(ptyId: string): { scrollback: string } {
    return { scrollback: this.sessions.get(ptyId)?.scrollback ?? '' }
  }

  write(ptyId: string, data: string): void {
    this.sessions.get(ptyId)?.pty.write(data)
  }

  resize(ptyId: string, cols: number, rows: number): void {
    try {
      this.sessions.get(ptyId)?.pty.resize(Math.max(2, cols), Math.max(1, rows))
    } catch {
      // resizing a dying pty throws; ignore
    }
  }

  kill(ptyId: string): void {
    const session = this.sessions.get(ptyId)
    if (!session) return
    this.sessions.delete(ptyId)
    this.syncPolling()
    try {
      session.pty.kill()
    } catch {
      // already dead
    }
  }

  killAll(): void {
    for (const ptyId of [...this.sessions.keys()]) this.kill(ptyId)
  }

  /**
   * Poll foreground-process titles once a second (only while PTYs exist) and
   * broadcast the busy map when anything changes. Windows' title reporting is
   * unreliable, so it degrades to "never busy" there — the badge just stays
   * a plain count.
   */
  private syncPolling(): void {
    if (this.sessions.size === 0) {
      if (this.pollTimer) clearInterval(this.pollTimer)
      this.pollTimer = null
      return
    }
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      let changed = false
      for (const session of this.sessions.values()) {
        let busy = false
        try {
          busy = process.platform !== 'win32' && isBusy(session.pty.process, session.shellName)
        } catch {
          // pty is winding down
        }
        if (busy !== session.busy) {
          session.busy = busy
          changed = true
        }
      }
      if (changed) {
        broadcast(
          'pty:status',
          Object.fromEntries([...this.sessions.values()].map((s) => [s.ptyId, s.busy])),
        )
      }
    }, 1000)
    // A status poll must never be the reason the process stays alive.
    this.pollTimer.unref()
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

/** Turn node-pty's opaque spawn errors into something a user can act on. */
function describeSpawnFailure(error: unknown, shell: string, cwd: string): string {
  const detail = errorText(error)
  if (/posix_spawnp? failed/i.test(detail)) {
    return (
      `Could not start a shell (${shell}): ${detail} ` +
      "This usually means node-pty's spawn-helper lost its executable bit or " +
      'was built for the wrong architecture. Reinstalling dependencies ' +
      '(npm ci) rebuilds it.'
    )
  }
  return `Could not start a shell (${shell}) in ${cwd}: ${detail}`
}

function defaultShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'powershell.exe', args: [] }
  }
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  // Login shell so the user's PATH/rc files load (pi lives there).
  return { command: shell, args: ['-l'] }
}

export const ptyManager = new PtyManager()
