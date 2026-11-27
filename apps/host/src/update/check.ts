import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { supportedArtifact } from '@phosphor/session-runtime/host-install/fetch'
import { fetchSignedManifest } from '@phosphor/session-runtime/host-install/signed-release'
import { errorText } from '@phosphor/shared/errors'
import { HOST_RELEASE_KEYS, type HostReleaseKey } from '@phosphor/shared/host-release'
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
  /** The newest signed release's version for this machine, if any; only manifests are read. */
  readonly latest: (signal: AbortSignal) => Promise<string | undefined>
  readonly log: RuntimeLog
  readonly random?: () => number
}

export interface ReleaseCheck {
  /** What the last successful check found; starts a background check when stale. */
  report(): { available?: string; checkedAt?: string }
  stop(): void
}

/**
 * The version a plain update would install on `target`, read as the updater
 * reads it (`fetchSignedRelease`): the signed `host-latest` release, v2 when
 * published (it lists Intel Macs) and v1 otherwise, with an artifact for this
 * target and a protocol at least ours. Undefined when the updater would refuse
 * the release. No downgrade check: the caller compares, and the updater keeps
 * its own guard.
 */
export async function newestRelease(
  source: { env: NodeJS.ProcessEnv; keys?: readonly HostReleaseKey[] },
  target: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const keys = source.keys ?? HOST_RELEASE_KEYS
  if (!keys.length) throw new Error('No Host release keys are pinned.')
  const { release } = await fetchSignedManifest({ env: source.env, keys }, signal)
  return supportedArtifact(release, target) ? release.version : undefined
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
        // An older release (one withdrawn) is a successful "no update", not a failure.
        ...(version && compareVersions(version, ports.installed) > 0 ? { available: version } : {}),
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
