import type { HostReleaseArtifactV2, HostReleaseManifestV2 } from '@phosphor/shared/host-release'
import { HOST_PROTOCOL_VERSION } from '@phosphor/shared/remote-host'
import { errorText } from '@phosphor/shared/errors'
import {
  fetchLocalRelease,
  type LocalReleaseCheck,
  type LocalReleaseSource,
} from '@phosphor/session-runtime/host-install/release-v2'
import { LOCAL_SERVICE_FEATURES } from '@phosphor/session-runtime/host-install/release-source'

/**
 * When Desktop looks for a Phosphor service release (D2 §3.10): at launch,
 * then every 30 minutes with jitter, and on window focus once 30 minutes have
 * passed. Until a signed v2 manifest lists the local-service features and an
 * artifact for this machine, Desktop stays on the in-app runtime.
 */

export const MANIFEST_RETRY_MS = 30 * 60_000
export const MANIFEST_JITTER_MS = 3 * 60_000

export type ReleaseWait = 'no-v2' | 'no-features' | 'no-artifact' | 'protocol' | 'error'

export type ReleaseReadiness =
  | { ready: true; release: HostReleaseManifestV2; artifact: HostReleaseArtifactV2 }
  | { ready: false; reason: ReleaseWait; detail: string }

/** Whether a fetched release may become this machine's service. Pure. */
export function releaseReadiness(
  check: LocalReleaseCheck,
  target: string,
  protocol: number = HOST_PROTOCOL_VERSION,
): ReleaseReadiness {
  if (check.manifest === 1)
    return {
      ready: false,
      reason: 'no-v2',
      detail: `Phosphor service ${check.version} predates local mode; checking again later.`,
    }
  const { release } = check
  if (!LOCAL_SERVICE_FEATURES.every((name) => release.features.includes(name)))
    return {
      ready: false,
      reason: 'no-features',
      detail: `Phosphor service ${release.version} does not support local mode yet.`,
    }
  const artifact = release.artifacts.find((a) => a.target === target)
  if (!artifact)
    return {
      ready: false,
      reason: 'no-artifact',
      detail: `There is no Phosphor service release for ${target} yet.`,
    }
  // Never install a service this Desktop cannot speak to.
  if (!release.protocols.includes(protocol))
    return {
      ready: false,
      reason: 'protocol',
      detail: `Phosphor service ${release.version} needs a newer Phosphor; update Phosphor first.`,
    }
  return { ready: true, release, artifact }
}

/** One signed lookup; network and verification failures become a wait, never an install. */
export async function checkRelease(
  source: LocalReleaseSource,
  target: string,
  signal: AbortSignal,
): Promise<ReleaseReadiness> {
  try {
    return releaseReadiness(await fetchLocalRelease(source, signal), target)
  } catch (error) {
    return { ready: false, reason: 'error', detail: errorText(error) }
  }
}

export interface ManifestWatchPorts {
  /** One attempt; 'done' stops the watch. A rejection counts as 'retry'. */
  attempt(signal: AbortSignal): Promise<'retry' | 'done'>
  now?: () => number
  random?: () => number
  setTimer?: (run: () => void, ms: number) => () => void
  log?: (message: string) => void
}

export interface ManifestWatch {
  start(): void
  /** A window gained focus: attempt now if the last attempt began 30 minutes ago. */
  focus(): void
  retry(): void
  stop(): void
  /** When the next timed attempt runs, or null while one runs or after 'done'. */
  nextAt(): number | null
}

const realTimer = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function createManifestWatch(ports: ManifestWatchPorts): ManifestWatch {
  const now = ports.now ?? Date.now
  const random = ports.random ?? Math.random
  const setTimer = ports.setTimer ?? realTimer
  let running: AbortController | null = null
  let cancel: (() => void) | null = null
  let next: number | null = null
  let lastStart = -Infinity
  let state: 'idle' | 'watching' | 'done' | 'stopped' = 'idle'

  const schedule = () => {
    const delay = MANIFEST_RETRY_MS + Math.floor(random() * MANIFEST_JITTER_MS)
    next = now() + delay
    cancel = setTimer(() => run(), delay)
  }
  const settle = (outcome: 'retry' | 'done', controller: AbortController) => {
    if (running !== controller) return
    running = null
    if (state !== 'watching') return
    if (outcome === 'done') state = 'done'
    else schedule()
  }
  const run = () => {
    if (state !== 'watching' || running) return
    cancel?.()
    cancel = null
    next = null
    lastStart = now()
    const controller = new AbortController()
    running = controller
    ports.attempt(controller.signal).then(
      (outcome) => settle(outcome, controller),
      (error: unknown) => {
        ports.log?.(`service release check failed: ${errorText(error)}`)
        settle('retry', controller)
      },
    )
  }
  return {
    start() {
      if (state !== 'idle') return
      state = 'watching'
      run()
    },
    focus() {
      if (now() - lastStart >= MANIFEST_RETRY_MS) run()
    },
    retry: run,
    stop() {
      state = 'stopped'
      cancel?.()
      cancel = null
      next = null
      running?.abort()
      running = null
    },
    nextAt: () => next,
  }
}
