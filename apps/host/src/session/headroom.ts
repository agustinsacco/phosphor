import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { HeadroomProxyProcess } from '@phosphor/session-runtime/headroom/proxy-process'
import { startHeadroomRelay } from '@phosphor/session-runtime/headroom/relay'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import type { OwnerCalls } from '@phosphor/shared/host-protocol-owner'
import { chooseSocketPath, clearStaleSocket, prepareSocketFolder } from '../api/local-server'
import { readSidecar, writeSidecar } from '../config/sidecar'
import { which } from '../machine/executables'
import type { OwnerHandlers } from '../owner/adapter'
import { freeHeadroomPort, ownsHeadroomPort } from './headroom-port'

export const FEATURE = 'headroom' as const

type Status = OwnerCalls['headroom.status']['result']

/** The persisted Headroom switch; the service reads it when it activates. */
export function writeHeadroomPreference(
  directory: string,
  uid: number | undefined,
  enabled: boolean,
): void {
  writeSidecar(
    directory,
    HOST_SIDECARS.headroom,
    { version: 1, enabled },
    {
      uid,
      known: ['version', 'enabled'],
    },
  )
}
interface HeadroomOptions {
  directory: string
  uid: number | undefined
  candidates: readonly string[]
  logFailed(): void
  prove?: typeof ownsHeadroomPort
  freePort?: typeof freeHeadroomPort
}

/** One instance per local run, shared by its owner handlers and its spawns. */
export class DaemonHeadroom {
  private env?: Record<string, string>
  private starting = Promise.resolve()
  private attempt?: AbortController
  private child?: HeadroomProxyProcess
  private relay?: Awaited<ReturnType<typeof startHeadroomRelay>>
  private path?: string
  private ready = false
  private closed = false

  constructor(private readonly options: HeadroomOptions) {}

  readonly handlers = {
    'headroom.status': async () => this.status(),
    'headroom.set': async ({ enabled }) => {
      if (this.closed) throw new Error('Headroom stopped')
      writeHeadroomPreference(this.options.directory, this.options.uid, enabled)
      if (enabled) this.ensure()
      else await this.cancel()
      return { enabled }
    },
  } satisfies OwnerHandlers

  private enabled(): boolean {
    const pref = readSidecar(
      this.options.directory,
      HOST_SIDECARS.headroom,
      (raw) => (raw.version === 1 && typeof raw.enabled === 'boolean' ? raw.enabled : null),
      { uid: this.options.uid },
    )
    return pref.state === 'ok' && pref.value
  }

  /** Runs only after acquiring the owner lock and validating the machine. */
  activate(env: Record<string, string>): void {
    this.env = env
    if (this.enabled()) this.ensure()
  }

  private livePort(): number | undefined {
    const child = this.child?.state.child
    return this.ready &&
      child &&
      !child.killed &&
      child.exitCode === null &&
      child.signalCode === null
      ? this.child?.port
      : undefined
  }

  socket(): string | undefined {
    return this.livePort() ? this.path : undefined
  }

  private status(): Status {
    if (!this.enabled()) return { enabled: false, state: 'off' }
    return {
      enabled: true,
      state: this.livePort() ? 'ready' : !this.env || this.attempt ? 'starting' : 'failed',
    }
  }

  private ensure(): void {
    if (this.closed || !this.env || this.attempt || this.livePort()) return
    const attempt = new AbortController()
    const env = this.env
    this.attempt = attempt
    this.starting = this.starting.then(async () => {
      try {
        await this.start(env, attempt.signal)
      } catch {
        this.child?.killOwned()
        if (!attempt.signal.aborted) this.options.logFailed()
      } finally {
        if (this.attempt === attempt) this.attempt = undefined
      }
    })
  }

  private async start(env: Record<string, string>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.ready = false
    if (!this.relay) {
      const path = chooseSocketPath(this.options.candidates)
      prepareSocketFolder(dirname(path), this.options.uid)
      await clearStaleSocket(path)
      this.relay = await startHeadroomRelay(path, () => this.livePort())
      this.path = path
    }
    const port = await (this.options.freePort ?? freeHeadroomPort)()
    signal.throwIfAborted()
    const proxy = new HeadroomProxyProcess(
      {
        port,
        spawnImpl: spawn,
        envImpl: async () => env,
        fetchImpl: (url, init) => fetch(url, { ...init, redirect: 'error' }),
        onWillQuit: () => {},
        logImpl: () => {},
      },
      async () => ({ binaryPath: await which('headroom', env.PATH ?? ''), version: null }),
    )
    this.child = proxy
    // Never call ensure/probe on the Desktop supervisor: it deliberately adopts a healthy endpoint.
    await proxy.startOwned(signal)
    signal.throwIfAborted()
    const child = proxy.state.child
    if (
      !child?.pid ||
      !proxy.state.running ||
      !(await (this.options.prove ?? ownsHeadroomPort)(child.pid, port))
    )
      throw new Error('Headroom child did not prove port ownership')
    signal.throwIfAborted()
    if (proxy.state.child !== child) throw new Error('Headroom stopped during startup')
    this.ready = true
  }

  private cancel(): Promise<void> {
    this.attempt?.abort()
    this.attempt = undefined
    this.ready = false
    this.child?.killOwned()
    this.starting = this.starting.then(async () => {
      await this.relay?.close()
      this.relay = undefined
      this.path = undefined
    })
    return this.starting
  }

  stop(): Promise<void> {
    this.closed = true
    return this.cancel()
  }
}

export function createHeadroomService(options: HeadroomOptions): DaemonHeadroom {
  return new DaemonHeadroom(options)
}
