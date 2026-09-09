import type { MaintenancePrefs, MaintenanceReport } from '@shared/models'
import { log } from '../debug-log'

/** Never sweep more often than this, whatever the pref says. */
export const MIN_INTERVAL_MINUTES = 15

/**
 * How long the app must have been up before the first sweep. Launch is the
 * busiest minute Phosphor has — window creation, session re-adoption, an update
 * check — and a `du` over 45 worktrees competes with all of it.
 */
export const WARMUP_MS = 5 * 60 * 1000

export interface SchedulerDeps {
  /** Read fresh each tick, so a pref change applies without a restart. */
  getPrefs: () => MaintenancePrefs
  /** Repos worth sweeping — the open workspaces, deduped by the caller. */
  getRepoPaths: () => string[]
  runSweep: (repoPath: string, prefs: MaintenancePrefs) => Promise<MaintenanceReport>
  onReport?: (report: MaintenanceReport) => void
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void }
  clearTimer?: (handle: unknown) => void
}

/**
 * Drives {@link sweep} on a timer for as long as the app is running.
 *
 * Deliberately a plain interval in main rather than anything cleverer: the
 * reaper this replaces derived its schedule from the fleet hub, and went out
 * with it when orchestration was removed on 2026-09-03 for touching session
 * spawn, IPC, the sidebar, the home screen and settings all at once. A timer
 * owns no session state, so nothing here can hold a session open or read
 * stale phase.
 */
export class MaintenanceScheduler {
  private handle: unknown = null
  private running = false
  private lastReports = new Map<string, MaintenanceReport>()
  private readonly startedAt = Date.now()

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.handle) return
    const minutes = Math.max(MIN_INTERVAL_MINUTES, this.deps.getPrefs().intervalMinutes)
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setInterval(fn, ms))
    const handle = setTimer(() => void this.tick(), minutes * 60 * 1000)
    // Unref'd: a maintenance timer must never be the reason the process stays
    // alive, and must never delay quit.
    handle.unref?.()
    this.handle = handle
    log('maintenance', 'scheduler started', { intervalMinutes: minutes })
  }

  stop(): void {
    if (!this.handle) return
    const clear = this.deps.clearTimer ?? ((h) => clearInterval(h as NodeJS.Timeout))
    clear(this.handle)
    this.handle = null
  }

  /** Latest report per repo, for the Settings surface. */
  reports(): MaintenanceReport[] {
    return [...this.lastReports.values()]
  }

  async tick(now = Date.now()): Promise<void> {
    const prefs = this.deps.getPrefs()
    if (!prefs.enabled) return
    // One sweep at a time. A `du` over a large workspace can outlast the
    // interval, and two concurrent sweeps would race on `git worktree remove`.
    if (this.running) return
    if (now - this.startedAt < WARMUP_MS) return

    this.running = true
    try {
      for (const repoPath of this.deps.getRepoPaths()) {
        try {
          const report = await this.deps.runSweep(repoPath, prefs)
          this.lastReports.set(repoPath, report)
          this.deps.onReport?.(report)
        } catch (error) {
          log('maintenance', 'sweep failed', { repoPath, error: String(error) })
        }
      }
    } finally {
      this.running = false
    }
  }
}
