/**
 * The updater's state machine, as a pure reducer.
 *
 * Kept free of `electron-updater` and Electron so every transition is unit
 * testable without a packaged app or a network. `updater.ts` owns the I/O and
 * feeds events in here.
 */

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  /**
   * Verifying and expanding a download. Only the macOS self-install path
   * reaches this: `electron-updater` does its own extraction inside
   * `download-progress`, so on Linux `downloading` runs straight to
   * `downloaded`.
   */
  | 'installing'
  /** Verified and staged; a restart installs it. */
  | 'downloaded'
  /**
   * An update exists but this install cannot apply it itself (unsigned macOS,
   * or a deb where the package manager owns the files). The UI offers a
   * download link instead of pretending a restart would work.
   */
  | 'manual-download'
  /** No update mechanism at all (dev, or an unpackaged run). */
  | 'unsupported'

export interface UpdateState {
  phase: UpdatePhase
  /** Version being offered; absent unless one is. */
  version?: string
  /** 0-100 while downloading. */
  progressPercent?: number
  /** Where to send the user when they must install by hand. */
  releaseUrl?: string
}

export type UpdateEvent =
  | { type: 'check-started' }
  | { type: 'update-available'; version: string }
  | { type: 'update-not-available' }
  | { type: 'download-progress'; percent: number }
  /** Download finished and verified; extraction and the swap begin. */
  | { type: 'install-started' }
  | { type: 'update-downloaded'; version: string }
  /** The install can detect but not self-apply. */
  | { type: 'manual-required'; version: string; releaseUrl: string }
  /**
   * A self-install attempt failed. Degrades to the manual path rather than to
   * silence: the user keeps a working way to update.
   */
  | { type: 'install-failed'; version: string; releaseUrl: string }
  | { type: 'error' }

export const IDLE: UpdateState = { phase: 'idle' }

/**
 * Fold one updater event into the current state.
 *
 * Errors deliberately collapse to `idle` rather than surfacing: a failed update
 * check is not the user's problem to solve and must never nag. `updater.ts`
 * logs the underlying error.
 */
export function reduceUpdate(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case 'check-started':
      // Never interrupt work in flight, or discard a staged update, to say
      // "checking". The periodic timer fires on its own schedule and will land
      // mid-download sooner or later.
      if (
        state.phase === 'downloading' ||
        state.phase === 'installing' ||
        state.phase === 'downloaded'
      ) {
        return state
      }
      return { phase: 'checking' }

    case 'update-available':
      return { phase: 'downloading', version: event.version, progressPercent: 0 }

    case 'update-not-available':
      // A staged update stays staged: a later check finding nothing newer does
      // not mean the one already on disk went away.
      if (state.phase === 'downloaded' || state.phase === 'manual-download') return state
      if (state.phase === 'downloading' || state.phase === 'installing') return state
      return IDLE

    case 'download-progress':
      if (state.phase !== 'downloading') return state
      return { ...state, progressPercent: clampPercent(event.percent) }

    case 'install-started':
      if (state.phase !== 'downloading') return state
      return { phase: 'installing', version: state.version }

    case 'update-downloaded':
      return { phase: 'downloaded', version: event.version }

    case 'manual-required':
    case 'install-failed':
      return { phase: 'manual-download', version: event.version, releaseUrl: event.releaseUrl }

    case 'error':
      // Keep anything already usable; otherwise fall back to silence.
      if (state.phase === 'downloaded' || state.phase === 'manual-download') return state
      return IDLE

    default:
      return state
  }
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, Math.round(percent)))
}
