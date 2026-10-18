/**
 * Headroom tool-result compression. One flag on purpose: enabling it means
 * "manage the local proxy and compress eligible tool results in new
 * sessions"; everything else (adoption vs spawn, health, failure handling)
 * is the supervisor's job, not configuration.
 */
export interface HeadroomPrefs {
  enabled: boolean
}

export const DEFAULT_HEADROOM_PREFS: HeadroomPrefs = {
  // Off by default: turning it on is a ~500 MB install decision plus a local
  // service, and Phosphor never makes that decision silently.
  enabled: false,
}

/** State of the managed (or adopted) local Headroom proxy. */
export interface HeadroomStatus {
  enabled: boolean
  /** The `headroom` binary was found on the login-shell PATH. */
  installed: boolean
  version?: string
  binaryPath?: string
  proxy: {
    /** `GET /health` answered on the last probe. */
    running: boolean
    url: string
    /** Phosphor spawned this proxy (and will kill it on quit); false = adopted. */
    owned: boolean
  }
  /** Why the last start attempt failed, when it did. */
  error?: string
}

/** One Advisor recommendation. Advice only — Phosphor never acts on these. */
export interface AdvisorFinding {
  id: string
  severity: 'serious' | 'warning' | 'tip'
  title: string
  detail: string
  /** Settings tab that owns the fix, when one does. */
  settingsTab?: string
}

/** Per-lane compression savings for the Optimization tab. */
export interface LaneSavings {
  path: string
  name?: string
  firstUserText?: string
  savedTokens: number
  totalTokens: number
}

/** Read-only aggregate behind `optimization:stats`. */
export interface OptimizationStats {
  savedTokens: number
  sessionsWithSavings: number
  sessionCount: number
  /** Lanes with savings, largest first. */
  lanes: LaneSavings[]
  advisor: AdvisorFinding[]
}
