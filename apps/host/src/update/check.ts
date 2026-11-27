import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { errorText } from '@phosphor/shared/errors'
import { compareVersions } from '@phosphor/shared/version'

const MINUTE = 60_000
/** The first check waits out the start: 2 to 5 minutes. */
const FIRST_MIN_MS = 2 * MINUTE
const FIRST_SPREAD_MS = 3 * MINUTE
/** Then every 6 hours, up to 30 minutes either side. */
const EVERY_MS = 6 * 60 * MINUTE
const JITTER_MS = 30 * MINUTE
/** A `machine.status` read older than this starts one check; the read never waits. */
const STALE_MS = 30 * MINUTE

export interface ReleaseCheckPorts {
  /** This Host's running version. */
  readonly installed: string
  /** The newest signed release's version; nothing is downloaded but the manifest. */
  readonly latest: (signal: AbortSignal) => Promise<string>
  readonly log: RuntimeLog
  readonly random?: () => number
}

export interface ReleaseCheck {
  /** What the last successful check found; starts a background check when stale. */
  report(): { available?: string; checkedAt?: string }
  stop(): void
}

/**
 * The Host's own background check of its signed release manifest, for
 * `machine.status`. A failed check is logged and changes nothing: the last
 * good answer stays.
 */
export function startReleaseCheck(ports: ReleaseCheckPorts): ReleaseCheck {
  const random = ports.random ?? Math.random
  const stopped = new AbortController()
  let found: { available?: string; checkedAt?: string } = {}
  let attemptedAt = Date.now()
  let checking = false
  let first = true
  let timer: ReturnType<typeof setTimeout> | undefined

  function schedule(ms: number) {
    clearTimeout(timer)
    timer = setTimeout(() => void check(), ms)
    timer.unref?.()
  }
  async function check() {
    if (checking || stopped.signal.aborted) return
    checking = true
    first = false
    attemptedAt = Date.now()
    clearTimeout(timer)
    try {
      const version = await ports.latest(stopped.signal)
      found = {
        ...(compareVersions(version, ports.installed) > 0 ? { available: version } : {}),
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      if (!stopped.signal.aborted)
        ports.log('host', 'update check failed', { error: errorText(error) })
    } finally {
      checking = false
      if (!stopped.signal.aborted) schedule(EVERY_MS + (random() * 2 - 1) * JITTER_MS)
    }
  }
  schedule(FIRST_MIN_MS + random() * FIRST_SPREAD_MS)
  return {
    report() {
      if (!first && !checking && Date.now() - attemptedAt >= STALE_MS) void check()
      return found
    },
    stop() {
      stopped.abort()
      clearTimeout(timer)
    },
  }
}
