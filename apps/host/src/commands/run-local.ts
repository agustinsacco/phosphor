import { open, unlink } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { dirname, join, resolve } from 'node:path'
import { HOST_SIDECARS, type LocalModeFile } from '@phosphor/shared/host-local'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import {
  acquireOwnerLock,
  OwnerLockUnavailable,
  type OwnerLock,
} from '@phosphor/session-runtime/owner-lock/owner-lock'
import { OwnerLockBusy, type OwnerLockPorts } from '@phosphor/session-runtime/owner-lock/types'
import { piAgentDir } from '@phosphor/session-runtime/pi/pi-paths'
import { readLocalMode, readSidecar } from '../config/sidecar'
import { IdentityFailure } from '../control/identity'
import { EnrollmentRefused, type ControlLink, type EnrollmentOffer } from '../control/link'
import { hostStateDirectory } from '../lanes/state-dir'
import type { LaneService } from '../lanes/service'
import type { HostStore } from '../lanes/store'
import type { LaneAdapter } from '../api/lanes'
import { runLogin } from './login'
import type { RunContext } from './run'
import type { RunParts } from './run-teardown'

/** How often a daemon whose owner lock a live Desktop holds tries again. */
export const OWNER_RETRY_MS = 30_000

/** The local-mode marker beside the config, or null for a headless Host. Unusable is a config failure (78). */
export function runLocalMode(context: RunContext): LocalModeFile | null {
  try {
    return readLocalMode(dirname(resolve(context.configPath)), context.uid)
  } catch {
    throw new IdentityFailure(
      'The local service marker is not usable. Run phosphor setup --local again.',
    )
  }
}

/** The local daemon as its owner calls see it. */
export interface LocalDaemon {
  readonly mode: LocalModeFile
  /** `owner-standby.json` holds the daemon back: no owner lock, lanes, routines, heartbeat or TCP API. */
  standby(): boolean
  /** Removes the standby marker durably; run then takes the owner lock and starts its lanes. */
  leaveStandby(): Promise<void>
  /** Null in standby and during start-up. */
  link(): ControlLink | null
  /** `machine.enroll begin`: refused in standby (N13) and while enrolled. */
  beginEnrollment(): Promise<EnrollmentOffer>
  cancelEnrollment(): Promise<void>
}

/** The machine's lanes once they start: their service and the one lane adapter both listeners share. */
export interface LocalSocketLanes {
  service: LaneService
  adapter: LaneAdapter
  /** The TCP listener's connections, so `connectionsPerClient` holds across both listeners. */
  peers(): Iterable<{ clientId(): string | undefined }>
}

/** The owner socket as run drives it. */
export interface LocalSocket {
  stop(): Promise<void>
  /**
   * Starts serving lanes, ops and the machine guard beside the owner calls.
   * Stopping it closes the lane connections and serves owner calls only again.
   */
  serveLanes?(lanes: LocalSocketLanes): { stop(): Promise<void> }
  /** The socket's connections, counted by the TCP listener's per-client admission. */
  connections?(): Iterable<{ clientId(): string | undefined }>
}

/**
 * Where D3's owner socket starts: in local mode once the state store is open,
 * standby included, before the owner lock and lanes. Stopped after teardown
 * has closed everything else.
 */
export type StartLocalSocket = (
  daemon: LocalDaemon,
  store: HostStore,
) => LocalSocket | Promise<LocalSocket>

export interface LocalDaemonPorts {
  ownerLock?: OwnerLockPorts
}

/** Runs `step` before the release run already has, which always runs too. */
function releaseFirst(parts: RunParts, step: () => Promise<void>) {
  const later = parts.release
  parts.release = async () => {
    try {
      await step()
    } finally {
      await later?.()
    }
  }
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(signal.reason as Error)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/** In-process `phosphor login`: its pending key, code and poll; the code goes to `offer`. */
function enrollInProcess(context: RunContext) {
  return (signal: AbortSignal, offer: (offer: EnrollmentOffer) => void) => {
    const now = context.now ?? Date.now
    return runLogin({
      ...context,
      signal: context.signal ? AbortSignal.any([signal, context.signal]) : signal,
      print: () => {},
      enrollment: (code) =>
        offer({
          userCode: code.userCode,
          fingerprint: code.fingerprint,
          expiresAt: new Date(now() + code.expiresInMs).toISOString(),
        }),
    })
  }
}

/** Removes the standby marker, then syncs its folder so the removal survives a crash. */
async function removeStandby(state: string) {
  await unlink(join(state, HOST_SIDECARS.standby)).catch((error: unknown) => {
    if (!errnoIs(error, 'ENOENT')) throw error
  })
  const folder = await open(state, 'r')
  try {
    await folder.sync()
  } finally {
    await folder.close()
  }
}

interface Owning {
  standby(): boolean
  /** Resolves once `leaveStandby` has run. */
  left(): Promise<void>
  log(event: string, fields?: Record<string, unknown>): void
}

/** Waits out standby, then takes the owner lock as `daemon`, retrying while a live holder has it. */
async function acquireWhenOwning(
  context: RunContext,
  owning: Owning,
  ports: LocalDaemonPorts,
  signal: AbortSignal,
): Promise<OwnerLock> {
  const wait = context.wait ?? ((ms, signal) => setTimeout(ms, undefined, { signal }))
  let busyLogged = false
  for (;;) {
    signal.throwIfAborted()
    if (owning.standby()) {
      owning.log('owner.standby')
      await Promise.race([owning.left(), aborted(signal)])
      continue
    }
    try {
      return await acquireOwnerLock(
        piAgentDir(context.env, context.home),
        'daemon',
        ports.ownerLock,
        { program: 'phosphor run', uid: context.uid },
      )
    } catch (error) {
      const busy =
        error instanceof OwnerLockBusy ||
        (error instanceof OwnerLockUnavailable && error.reason === 'contended')
      if (!busy)
        throw new IdentityFailure(error instanceof Error ? error.message : 'Owner lock failed.')
      if (!busyLogged)
        owning.log(
          'owner.busy',
          error instanceof OwnerLockBusy ? { holder: error.holder.owner } : {},
        )
      busyLogged = true
      await wait(OWNER_RETRY_MS, signal)
    }
  }
}

export function createLocalDaemon(
  context: RunContext,
  mode: LocalModeFile,
  ports: LocalDaemonPorts = {},
) {
  const state = hostStateDirectory(context.env, context.home)
  let link: ControlLink | null = null
  let leave: () => void = () => {}
  const owning: Owning = {
    // A marker this Host cannot read still holds it back: never acquire while one exists.
    standby: () =>
      readSidecar(state, HOST_SIDECARS.standby, (raw) => raw, { uid: context.uid }).state !==
      'missing',
    left: () => new Promise<void>((resolve) => (leave = resolve)),
    log: (event, fields = {}) => context.log?.('host', event, fields),
  }
  const daemon: LocalDaemon = {
    mode,
    standby: owning.standby,
    async leaveStandby() {
      await removeStandby(state)
      owning.log('owner.standby_left')
      leave()
    },
    link: () => link,
    async beginEnrollment() {
      if (owning.standby()) throw new EnrollmentRefused('standby')
      if (!link) throw new EnrollmentRefused('starting')
      return link.beginEnrollment()
    },
    cancelEnrollment: async () => link?.cancelEnrollment(),
  }
  return {
    daemon,
    enroll: enrollInProcess(context),
    /** Starts the socket seam, then holds start-up until this daemon owns the machine's lanes. */
    async own(
      parts: RunParts,
      store: HostStore,
      signal: AbortSignal,
    ): Promise<LocalSocket | undefined> {
      const socket = await context.startLocalSocket?.(daemon, store)
      if (socket) releaseFirst(parts, () => socket.stop())
      const lock = await acquireWhenOwning(context, owning, ports, signal)
      releaseFirst(parts, () => lock.release())
      owning.log('owner.acquired')
      return socket
    },
    attach(started: ControlLink) {
      link = started
    },
  }
}

export type LocalRun = ReturnType<typeof createLocalDaemon>
