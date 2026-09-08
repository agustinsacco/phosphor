import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { HeadroomStatus } from '@shared/models'
import { getPrefs, setHeadroomPrefs } from '../store'
import { resolveBinary } from '../pi/packages'
import { extractVersion } from '../pi/health'
import { piProcessEnv } from '../pi/shell-env'
import { log } from '../debug-log'

const execFileAsync = promisify(execFile)

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

export const HEADROOM_PROXY_PORT = 8787
export const HEADROOM_PROXY_URL = `http://127.0.0.1:${HEADROOM_PROXY_PORT}`

const HEALTH_TIMEOUT_MS = 1500
/** How long a spawned proxy gets to answer /health before we call it failed. */
const STARTUP_DEADLINE_MS = 15_000
/** An exit this soon after spawn counts as a crash, not a shutdown. */
const CRASH_WINDOW_MS = 10_000
/** Crashes inside the window before auto-start gives up. */
const MAX_CRASHES = 2

/** Argv for the managed proxy. Exported for tests — this list is a contract. */
export function proxyArgs(): string[] {
  return [
    'proxy',
    '--host',
    '127.0.0.1',
    '--port',
    String(HEADROOM_PROXY_PORT),
    // The subscription tracker stores ONE bearer token and polls Anthropic
    // with it; with multiple Claude accounts that is wrong data, so it is off
    // unconditionally (docs/specs/headroom-compression.md).
    '--no-subscription-tracking',
  ]
}

/** Env for the managed proxy. Exported for tests — also a contract. */
export function proxyEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    HEADROOM_BEACON: 'off',
    DO_NOT_TRACK: '1',
    HEADROOM_UPDATE_CHECK: 'off',
    // Lossless-or-noop families only. Text compressors (code_aware, kompress)
    // are silently lossy and must never run under a Phosphor-managed proxy.
    HEADROOM_COMPRESSORS: 'smart_crusher,tabular',
    // Defends the loopback bind against a stray HEADROOM_HOST in the user's
    // shell profile (the CLI reads it as the --host default).
    HEADROOM_HOST: '127.0.0.1',
  }
}

interface SupervisorDeps {
  fetchImpl: typeof fetch
  spawnImpl: typeof spawn
  resolveBinaryImpl: (name: string) => Promise<string | null>
  envImpl: () => Promise<NodeJS.ProcessEnv>
  versionImpl: (binaryPath: string) => Promise<string | null>
  onWillQuit: (handler: () => void) => void
  isEnabled: () => boolean
  setEnabled: (enabled: boolean) => void
  logImpl: (message: string) => void
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
  let child: ChildProcess | null = null
  let childStartedAt = 0
  let running = false
  let lastError: string | undefined
  let crashes = 0
  let quitHookInstalled = false
  let inFlight: Promise<void> | null = null

  interface Detection {
    binaryPath: string | null
    version: string | null
  }
  let detection: { value: Detection; at: number } | null = null
  const DETECT_TTL_MS = 5 * 60_000

  async function detect(): Promise<Detection> {
    if (detection && Date.now() - detection.at < DETECT_TTL_MS && detection.value.binaryPath) {
      return detection.value
    }
    const binaryPath = await deps.resolveBinaryImpl('headroom')
    const version = binaryPath ? await deps.versionImpl(binaryPath) : null
    const value = { binaryPath, version }
    detection = { value, at: Date.now() }
    return value
  }

  async function probe(): Promise<boolean> {
    try {
      const res = await deps.fetchImpl(`${HEADROOM_PROXY_URL}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      })
      running = res.ok
    } catch {
      running = false
    }
    if (!running && child && child.exitCode === null) {
      // Owned child alive but not answering: still starting or wedged. Treat
      // as not running for session env, but keep the child — the startup
      // deadline in startOwned decides its fate, not a later probe.
      return false
    }
    return running
  }

  function killOwned(): void {
    if (child && child.exitCode === null) {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
    child = null
    running = false
  }

  async function startOwned(): Promise<void> {
    const found = await detect()
    if (!found.binaryPath) {
      lastError = 'headroom is not installed'
      return
    }
    if (crashes >= MAX_CRASHES) {
      lastError = 'the proxy exited immediately twice; start it manually to see why'
      return
    }
    if (!quitHookInstalled) {
      quitHookInstalled = true
      deps.onWillQuit(killOwned)
    }

    const started = Date.now()
    childStartedAt = started
    const spawned = deps.spawnImpl(found.binaryPath, proxyArgs(), {
      env: proxyEnv(await deps.envImpl()) as Record<string, string>,
      stdio: ['ignore', 'ignore', 'pipe'],
      // Deliberately NOT detached: if Phosphor dies without will-quit firing,
      // the OS still tears the proxy down with the process group.
      detached: false,
    })
    child = spawned
    let stderrTail = ''
    spawned.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })
    spawned.on('error', (error) => {
      lastError = error.message
      if (child === spawned) child = null
      running = false
    })
    spawned.on('exit', (code) => {
      if (child !== spawned) return
      child = null
      running = false
      const lifetime = Date.now() - childStartedAt
      if (lifetime < CRASH_WINDOW_MS) {
        crashes += 1
        lastError = `proxy exited with code ${code ?? 'null'} after ${lifetime} ms${
          stderrTail ? `: ${stderrTail.trim().split('\n').pop()}` : ''
        }`
      } else {
        lastError = `proxy exited with code ${code ?? 'null'}`
      }
      deps.logImpl(lastError)
    })

    // Poll /health until the deadline; uvicorn takes a moment to bind.
    while (Date.now() - started < STARTUP_DEADLINE_MS) {
      if (child !== spawned) return // crashed; exit handler recorded why
      if (await probe()) {
        crashes = 0
        lastError = undefined
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    lastError = 'proxy did not answer /health within the startup deadline'
    killOwned()
  }

  async function ensureOnce(): Promise<void> {
    if (!deps.isEnabled()) return
    if (await probe()) return // healthy — adopted or ours, either way done
    await startOwned()
  }

  async function ensure(): Promise<void> {
    // Single-flight: two callers must never race two spawns.
    inFlight ??= ensureOnce().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  async function status(): Promise<HeadroomStatus> {
    const found = await detect()
    await probe()
    return {
      enabled: deps.isEnabled(),
      installed: found.binaryPath !== null,
      ...(found.version ? { version: found.version } : {}),
      ...(found.binaryPath ? { binaryPath: found.binaryPath } : {}),
      proxy: {
        running,
        url: HEADROOM_PROXY_URL,
        owned: child !== null && child.exitCode === null,
      },
      ...(lastError && !running ? { error: lastError } : {}),
    }
  }

  return {
    status,
    ensure,
    async setEnabled(enabled: boolean): Promise<HeadroomStatus> {
      deps.setEnabled(enabled)
      if (enabled) {
        crashes = 0 // a human decision resets the crash budget
        await ensure()
      } else {
        killOwned() // adopted proxies are left alone — we did not start them
      }
      return status()
    },
    async start(): Promise<HeadroomStatus> {
      crashes = 0
      await ensure()
      return status()
    },
    async stop(): Promise<HeadroomStatus> {
      killOwned()
      return status()
    },
    sessionEnv(): Record<string, string> {
      if (!deps.isEnabled()) return {}
      // Self-heal for the NEXT session; this one reads the current belief.
      // Stale-belief risk is bounded by the extension failing open: a dead
      // URL costs one 1.5 s health probe in-session, then it disables itself.
      void ensure().catch(() => undefined)
      return running ? { PHOSPHOR_HEADROOM_URL: HEADROOM_PROXY_URL } : {}
    },
  }
}

async function headroomVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'], { timeout: 15_000 })
    return extractVersion(stdout) ?? extractVersion(stderr)
  } catch {
    return null
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
