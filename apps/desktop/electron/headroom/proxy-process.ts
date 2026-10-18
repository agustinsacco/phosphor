import type { ChildProcess, spawn } from 'node:child_process'
import type { Detection } from './proxy-detection'

export const HEADROOM_PROXY_PORT = 8787
export const HEADROOM_PROXY_URL = `http://127.0.0.1:${HEADROOM_PROXY_PORT}`

/** Loopback URL for a port. The port is only ever non-default in tests. */
export function proxyUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

const HEALTH_TIMEOUT_MS = 1500
/** How long a spawned proxy gets to answer /health before we call it failed. */
const STARTUP_DEADLINE_MS = 15_000
/** An exit this soon after spawn counts as a crash, not a shutdown. */
const CRASH_WINDOW_MS = 10_000
/** Crashes inside the window before auto-start gives up. */
const MAX_CRASHES = 2

/** Argv for the managed proxy. Exported for tests — this list is a contract. */
export function proxyArgs(port: number = HEADROOM_PROXY_PORT): string[] {
  return [
    'proxy',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    // The subscription tracker stores ONE bearer token and polls Anthropic
    // with it; with multiple Claude accounts that is wrong data, so it is off
    // unconditionally.
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

export interface ProxyProcessDeps {
  fetchImpl: typeof fetch
  spawnImpl: typeof spawn
  envImpl: () => Promise<NodeJS.ProcessEnv>
  onWillQuit: (handler: () => void) => void
  logImpl: (message: string) => void
  /** Defaults to 8787. Only a test ever moves it off the machine-wide port. */
  port?: number
}

export interface SupervisorState {
  child: ChildProcess | null
  childStartedAt: number
  running: boolean
  lastError: string | undefined
  crashes: number
  quitHookInstalled: boolean
}

/** Owns only children spawned here; a healthy external endpoint is never killed. */
export class HeadroomProxyProcess {
  readonly state: SupervisorState = {
    child: null,
    childStartedAt: 0,
    running: false,
    lastError: undefined,
    crashes: 0,
    quitHookInstalled: false,
  }
  readonly port: number
  readonly url: string

  constructor(
    private readonly deps: ProxyProcessDeps,
    private readonly detect: () => Promise<Detection>,
  ) {
    this.port = deps.port ?? HEADROOM_PROXY_PORT
    this.url = proxyUrl(this.port)
  }

  async probe(): Promise<boolean> {
    try {
      const res = await this.deps.fetchImpl(`${this.url}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      })
      this.state.running = res.ok
    } catch {
      this.state.running = false
    }
    if (!this.state.running && this.state.child && this.state.child.exitCode === null) {
      // Owned child alive but not answering: still starting or wedged. Treat
      // as not running for session env, but keep the child — the startup
      // deadline in startOwned decides its fate, not a later probe.
      return false
    }
    return this.state.running
  }

  killOwned(): void {
    if (this.state.child && this.state.child.exitCode === null) {
      try {
        this.state.child.kill()
      } catch {
        // Already gone.
      }
    }
    this.state.child = null
    this.state.running = false
  }

  async startOwned(): Promise<void> {
    const found = await this.detect()
    if (!found.binaryPath) {
      this.state.lastError = 'headroom is not installed'
      return
    }
    if (this.state.crashes >= MAX_CRASHES) {
      this.state.lastError = 'the proxy exited immediately twice; start it manually to see why'
      return
    }
    if (!this.state.quitHookInstalled) {
      this.state.quitHookInstalled = true
      this.deps.onWillQuit(() => this.killOwned())
    }

    const started = Date.now()
    this.state.childStartedAt = started
    const spawned = this.deps.spawnImpl(found.binaryPath, proxyArgs(this.port), {
      env: proxyEnv(await this.deps.envImpl()) as Record<string, string>,
      stdio: ['ignore', 'ignore', 'pipe'],
      // Deliberately NOT detached: if Phosphor dies without will-quit firing,
      // the OS still tears the proxy down with the process group.
      detached: false,
    })
    this.state.child = spawned
    this.observeChild(spawned)

    // Poll /health until the deadline; uvicorn takes a moment to bind.
    while (Date.now() - started < STARTUP_DEADLINE_MS) {
      if (this.state.child !== spawned) return // crashed; exit handler recorded why
      if (await this.probe()) {
        this.state.crashes = 0
        this.state.lastError = undefined
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    this.state.lastError = 'proxy did not answer /health within the startup deadline'
    this.killOwned()
  }

  private observeChild(spawned: ChildProcess): void {
    let stderrTail = ''
    spawned.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })
    spawned.on('error', (error) => {
      this.state.lastError = error.message
      if (this.state.child === spawned) this.state.child = null
      this.state.running = false
    })
    spawned.on('exit', (code) => {
      if (this.state.child !== spawned) return
      this.state.child = null
      this.state.running = false
      const lifetime = Date.now() - this.state.childStartedAt
      if (lifetime < CRASH_WINDOW_MS) {
        this.state.crashes += 1
        this.state.lastError = `proxy exited with code ${code ?? 'null'} after ${lifetime} ms${
          stderrTail ? `: ${stderrTail.trim().split('\n').pop()}` : ''
        }`
      } else {
        this.state.lastError = `proxy exited with code ${code ?? 'null'}`
      }
      this.deps.logImpl(this.state.lastError)
    })
  }
}
