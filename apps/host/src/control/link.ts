import type { LocalMode } from '@phosphor/shared/host-protocol-owner'

/** How often a link with no heartbeat re-reads the identity files (a CLI login, a new enrollment). */
export const LINK_RECHECK_MS = 60_000

/** What a person enters in Phosphor to approve this machine. */
export interface EnrollmentOffer {
  readonly userCode: string
  readonly fingerprint: string
  readonly expiresAt: string
}

export type ControlLinkState =
  | { readonly kind: 'local' }
  | { readonly kind: 'enrolling'; readonly offer: EnrollmentOffer }
  | {
      readonly kind: 'enrolled'
      readonly hostId: string
      readonly label: string
      readonly ownerLogin: string | null
    }
  /** A 410 was seen for `hostId`; its identity files are kept, as on every Host. */
  | { readonly kind: 'removed'; readonly at: string; readonly hostId: string }

/** An enrolled identity, as far as the link needs to know it. */
export interface LinkEnrollment {
  readonly identity: {
    readonly hostId: string
    readonly label: string
    readonly ownerLogin: string | null
  }
}

/** One enrollment's heartbeat. `run` resolves 77 when control answers 410. */
export interface LinkSession {
  run(): Promise<number>
  drain(): Promise<{ state: 'stopped' | 'failed' }>
}

export interface ControlLinkPorts<T extends LinkEnrollment> {
  /** The local-mode marker exists: a 410 keeps the process and its lanes. */
  readonly local: boolean
  /** The saved identity, read under the identity lock; null when there is none. */
  load(): Promise<T | null>
  /** Starts the heartbeat and the TCP API for an identity. */
  connect(enrollment: T): LinkSession
  /** Stops the TCP API after a removal. */
  disconnect(): Promise<void>
  /**
   * Enrolls this machine in-process and saves its identity on approval.
   * Calls `offer` once the code exists. Absent when enrollment is not served.
   */
  enroll?(signal: AbortSignal, offer: (offer: EnrollmentOffer) => void): Promise<unknown>
  now(): number
  wait(ms: number, signal: AbortSignal): Promise<void>
  log(event: string, fields: Record<string, unknown>): void
}

export type EnrollmentRefusal = 'enrolled' | 'standby' | 'starting' | 'stopping' | 'unavailable'

/** `machine.enroll` was refused. A machine never re-enrolls while enrolled (N13). */
export class EnrollmentRefused extends Error {
  readonly reason: EnrollmentRefusal

  constructor(reason: EnrollmentRefusal, message = `Enrollment refused: ${reason}.`) {
    super(message)
    this.name = 'EnrollmentRefused'
    this.reason = reason
  }
}

export interface ControlLink {
  state(): ControlLinkState
  mode(): LocalMode
  onChange(listener: () => void): () => void
  /** Connects the identity run started with, if any. */
  start(): void
  /** Re-reads the identity; connects one that appeared since the link started or was removed. */
  reload(): Promise<void>
  beginEnrollment(): Promise<EnrollmentOffer>
  cancelEnrollment(): Promise<void>
  /** Resolves when the process must end: 77 on a 410 without the marker, else 0 once drained. */
  run(): Promise<number>
  drain(): Promise<{ state: 'stopped' | 'failed' }>
  exitCode(): number
}

function signalled() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

interface Enrolling {
  abort: AbortController
  done: Promise<void>
}

/**
 * The machine's link to control. Lanes never depend on it: enrollment and
 * removal are state changes here, and only the heartbeat and TCP API follow.
 */
export function createControlLink<T extends LinkEnrollment>(
  ports: ControlLinkPorts<T>,
  initial: T | null,
): ControlLink {
  let state: ControlLinkState = { kind: 'local' }
  let session: LinkSession | undefined
  let enrolling: Enrolling | undefined
  let ending = false
  const stop = new AbortController()
  let wake = signalled()
  const listeners = new Set<() => void>()
  const set = (next: ControlLinkState) => {
    state = next
    for (const listener of listeners) listener()
  }
  const notify = () => {
    const woken = wake
    wake = signalled()
    woken.resolve()
  }

  function connect(enrollment: T) {
    session = ports.connect(enrollment)
    const { hostId, label, ownerLogin } = enrollment.identity
    set({ kind: 'enrolled', hostId, label, ownerLogin })
    ports.log('control.enrolled', { hostId })
    notify()
  }

  async function reload() {
    if (ending || session || enrolling) return
    const found = await ports.load()
    if (ending || session || enrolling || !found) return
    if (state.kind === 'removed' && state.hostId === found.identity.hostId) return
    connect(found)
  }

  /** Waits for a change, or re-reads the identity every `LINK_RECHECK_MS`. */
  async function idle() {
    const turn = new AbortController()
    const signal = AbortSignal.any([stop.signal, turn.signal])
    await Promise.race([wake.promise, ports.wait(LINK_RECHECK_MS, signal).catch(() => {})])
    turn.abort()
    if (ending || session) return
    await reload().catch((error: unknown) =>
      ports.log('control.reload_failed', { code: error instanceof Error ? error.name : 'unknown' }),
    )
  }

  async function run(): Promise<number> {
    while (!ending) {
      if (!session) {
        await idle()
        continue
      }
      const code = await session.run()
      if (code !== 77 || !ports.local || ending) return code
      const hostId = state.kind === 'enrolled' ? state.hostId : ''
      session = undefined
      set({ kind: 'removed', at: new Date(ports.now()).toISOString(), hostId })
      ports.log('control.removed', { hostId })
      await ports.disconnect()
    }
    return 0
  }

  function finishEnrollment(previous: ControlLinkState) {
    enrolling = undefined
    if (state.kind === 'enrolling') set(previous)
    notify()
  }

  async function beginEnrollment(): Promise<EnrollmentOffer> {
    if (ending) throw new EnrollmentRefused('stopping')
    if (state.kind === 'enrolling') return state.offer
    if (state.kind === 'enrolled') throw new EnrollmentRefused('enrolled')
    const enroll = ports.enroll
    if (!enroll) throw new EnrollmentRefused('unavailable')
    const previous = state
    const abort = new AbortController()
    let offered: ((offer: EnrollmentOffer) => void) | undefined
    let ended: ((error: Error) => void) | undefined
    const offer = new Promise<EnrollmentOffer>((resolve, reject) => {
      offered = resolve
      ended = reject
    })
    const work = enroll(abort.signal, (next) => {
      if (abort.signal.aborted || state.kind === 'enrolled') return
      set({ kind: 'enrolling', offer: next })
      offered?.(next)
    })
    const done = work.then(
      () => {
        finishEnrollment(previous)
        ended?.(new EnrollmentRefused('unavailable', 'The enrollment ended without a code.'))
      },
      (error: unknown) => {
        finishEnrollment(previous)
        ended?.(error instanceof Error ? error : new Error('Enrollment failed.'))
      },
    )
    enrolling = { abort, done }
    return offer
  }

  return {
    state: () => state,
    mode: () => state.kind,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      if (initial && !session && !ending) connect(initial)
    },
    reload,
    beginEnrollment,
    async cancelEnrollment() {
      const current = enrolling
      if (!current) return
      current.abort.abort()
      await current.done
    },
    run,
    async drain() {
      ending = true
      stop.abort()
      enrolling?.abort.abort()
      notify()
      const result = session ? await session.drain() : { state: 'stopped' as const }
      await enrolling?.done
      return result
    },
    exitCode: () => 0,
  }
}
