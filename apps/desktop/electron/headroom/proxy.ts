import { spawn } from 'node:child_process'
import { app } from 'electron'
import type { HeadroomStatus } from '@shared/models'
import { getPrefs, setHeadroomPrefs } from '../store'
import { resolveBinary } from '../pi/packages'
import { piProcessEnv } from '../pi/shell-env'
import { log } from '../debug-log'
import { createProxyDetection, headroomVersion, type ProxyDetectionDeps } from './proxy-detection'
import { HeadroomProxyProcess, type ProxyProcessDeps } from './proxy-process'

export {
  HEADROOM_PROXY_PORT,
  HEADROOM_PROXY_URL,
  proxyUrl,
  proxyArgs,
  proxyEnv,
} from './proxy-process'

/**
 * Supervisor for the local Headroom proxy (the service behind
 * `pi-ext/headroom.ts`). The lifecycle rules are strict on purpose — a
 * compression sidecar must never be able to hurt the machine it runs on:
 *
 * - ONE proxy per machine, loopback only. An already-healthy proxy on the
 *   port is ADOPTED, never duplicated; Phosphor only ever kills a proxy it
 *   spawned itself.
 * - An owned proxy never outlives Phosphor (`will-quit` kill, and the child is
 *   not detached so the OS reaps it with us).
 * - No restart loops: a proxy that dies twice right after starting stays
 *   down with an error until the user acts.
 * - Privacy pinned per spawn: beacon off, update check off, subscription
 *   tracking off (required for multi-account Claude setups), and the
 *   compressor list pinned to the lossless families — the fourth defense
 *   behind the extension's own JSON gate, omission check and size checks.
 * - Phosphor never edits Headroom's config or any provider settings file; the
 *   only integration is env on processes Phosphor itself spawns.
 */

interface SupervisorDeps extends ProxyDetectionDeps, ProxyProcessDeps {
  isEnabled: () => boolean
  setEnabled: (enabled: boolean) => void
}

export interface HeadroomSupervisor {
  status(): Promise<HeadroomStatus>
  setEnabled(enabled: boolean): Promise<HeadroomStatus>
  start(): Promise<HeadroomStatus>
  stop(): Promise<HeadroomStatus>
  /** Env for a new pi session — `{}` unless the proxy is believed healthy. */
  sessionEnv(): Record<string, string>
  /** Fire-and-forget heal: bring the proxy up if enabled and down. */
  ensure(): Promise<void>
}

/** Factory so tests can inject every side effect. */
export function createHeadroomSupervisor(deps: SupervisorDeps): HeadroomSupervisor {
  const detect = createProxyDetection(deps)
  const process = new HeadroomProxyProcess(deps, detect)
  const state = process.state
  let inFlight: Promise<void> | null = null

  async function ensureOnce(): Promise<void> {
    if (!deps.isEnabled()) return
    if (await process.probe()) return // healthy — adopted or ours, either way done
    await process.startOwned()
  }

  async function ensure(): Promise<void> {
    // Single-flight: two callers must never race two spawns.
    inFlight ??= ensureOnce().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const status = (): Promise<HeadroomStatus> => supervisorStatus(deps, process, detect)

  return {
    status,
    ensure,
    async setEnabled(enabled: boolean): Promise<HeadroomStatus> {
      deps.setEnabled(enabled)
      if (enabled) {
        state.crashes = 0 // a human decision resets the crash budget
        await ensure()
      } else {
        process.killOwned() // adopted proxies are left alone — we did not start them
      }
      return status()
    },
    async start(): Promise<HeadroomStatus> {
      state.crashes = 0
      await ensure()
      return status()
    },
    async stop(): Promise<HeadroomStatus> {
      process.killOwned()
      return status()
    },
    sessionEnv(): Record<string, string> {
      if (!deps.isEnabled()) return {}
      // Self-heal for the NEXT session; this one reads the current belief.
      // Stale-belief risk is bounded by the extension failing open: a dead
      // URL costs one 1.5 s health probe in-session, then it disables itself.
      void ensure().catch(() => undefined)
      return state.running ? { PHOSPHOR_HEADROOM_URL: process.url } : {}
    },
  }
}

async function supervisorStatus(
  deps: SupervisorDeps,
  process: HeadroomProxyProcess,
  detect: ReturnType<typeof createProxyDetection>,
): Promise<HeadroomStatus> {
  const found = await detect()
  await process.probe()
  const { child, running, lastError } = process.state
  return {
    enabled: deps.isEnabled(),
    installed: found.binaryPath !== null,
    ...(found.version ? { version: found.version } : {}),
    ...(found.binaryPath ? { binaryPath: found.binaryPath } : {}),
    proxy: {
      running,
      url: process.url,
      owned: child !== null && child.exitCode === null,
    },
    ...(lastError && !running ? { error: lastError } : {}),
  }
}

/** The app-wide supervisor. Constructed lazily; nothing runs until used. */
let supervisor: HeadroomSupervisor | null = null

export function headroomSupervisor(): HeadroomSupervisor {
  supervisor ??= createHeadroomSupervisor({
    fetchImpl: fetch,
    spawnImpl: spawn,
    resolveBinaryImpl: resolveBinary,
    envImpl: piProcessEnv,
    versionImpl: headroomVersion,
    onWillQuit: (handler) => app.on('will-quit', handler),
    isEnabled: () => getPrefs().headroom.enabled,
    setEnabled: (enabled) => setHeadroomPrefs({ enabled }),
    logImpl: (message) => log('headroom', message),
  })
  return supervisor
}
