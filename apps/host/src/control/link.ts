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
  drain(): Promise<{ state: 'stopped' }>
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
  drain(): Promise<{ state: 'stopped' }>
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

/** One link's mutable state, shared by the steps below. */
interface LinkCore<T extends LinkEnrollment> {
  ports: ControlLinkPorts<T>
  state: ControlLinkState
  session?: LinkSession
  enrolling?: Enrolling
  ending: boolean
  stop: AbortController
  wake: ReturnType<typeof signalled>
  listeners: Set<() => void>
}

function set(core: LinkCore<LinkEnrollment>, next: ControlLinkState) {
  core.state = next
  for (const listener of core.listeners) listener()
}

function notify(core: LinkCore<LinkEnrollment>) {
  const woken = core.wake
  core.wake = signalled()
  woken.resolve()
}

function connect<T extends LinkEnrollment>(core: LinkCore<T>, enrollment: T) {
  core.session = core.ports.connect(enrollment)
  const { hostId, label, ownerLogin } = enrollment.identity
  set(core, { kind: 'enrolled', hostId, label, ownerLogin })
  core.ports.log('control.enrolled', { hostId })
  notify(core)
}

async function reload<T extends LinkEnrollment>(core: LinkCore<T>) {
  const busy = () => core.ending || core.session !== undefined || core.enrolling !== undefined
  if (busy()) return
  const found = await core.ports.load()
  if (busy() || !found) return
  if (core.state.kind === 'removed' && core.state.hostId === found.identity.hostId) return
  connect(core, found)
}

/** Waits for a change, or re-reads the identity every `LINK_RECHECK_MS`. */
async function idle<T extends LinkEnrollment>(core: LinkCore<T>) {
  const turn = new AbortController()
  const signal = AbortSignal.any([core.stop.signal, turn.signal])
  await Promise.race([core.wake.promise, core.ports.wait(LINK_RECHECK_MS, signal).catch(() => {})])
  turn.abort()
  if (core.ending || core.session) return
  await reload(core).catch((error: unknown) =>
    core.ports.log('control.reload_failed', {
      code: error instanceof Error ? error.name : 'unknown',
    }),
  )
}

async function run<T extends LinkEnrollment>(core: LinkCore<T>): Promise<number> {
  while (!core.ending) {
    if (!core.session) {
      await idle(core)
      continue
    }
    const code = await core.session.run()
    if (code !== 77 || !core.ports.local || core.ending) return code
    const hostId = core.state.kind === 'enrolled' ? core.state.hostId : ''
    core.session = undefined
    set(core, { kind: 'removed', at: new Date(core.ports.now()).toISOString(), hostId })
    core.ports.log('control.removed', { hostId })
    await core.ports.disconnect()
  }
  return 0
}

function finishEnrollment(core: LinkCore<LinkEnrollment>, previous: ControlLinkState) {
  core.enrolling = undefined
  if (core.state.kind === 'enrolling') set(core, previous)
  notify(core)
}

async function beginEnrollment<T extends LinkEnrollment>(
  core: LinkCore<T>,
): Promise<EnrollmentOffer> {
  if (core.ending) throw new EnrollmentRefused('stopping')
  if (core.state.kind === 'enrolling') return core.state.offer
  if (core.state.kind === 'enrolled') throw new EnrollmentRefused('enrolled')
  const enroll = core.ports.enroll
  if (!enroll) throw new EnrollmentRefused('unavailable')
  const previous = core.state
  const abort = new AbortController()
  let offered: ((offer: EnrollmentOffer) => void) | undefined
  let ended: ((error: Error) => void) | undefined
  const offer = new Promise<EnrollmentOffer>((resolve, reject) => {
    offered = resolve
    ended = reject
  })
  const work = enroll(abort.signal, (next) => {
    if (abort.signal.aborted || core.state.kind === 'enrolled') return
    set(core, { kind: 'enrolling', offer: next })
    offered?.(next)
  })
  const done = work.then(
    () => {
      finishEnrollment(core, previous)
      ended?.(new EnrollmentRefused('unavailable', 'The enrollment ended without a code.'))
    },
    (error: unknown) => {
      finishEnrollment(core, previous)
      ended?.(error instanceof Error ? error : new Error('Enrollment failed.'))
    },
  )
  core.enrolling = { abort, done }
  return offer
}

async function drain<T extends LinkEnrollment>(core: LinkCore<T>): Promise<{ state: 'stopped' }> {
  core.ending = true
  core.stop.abort()
  core.enrolling?.abort.abort()
  notify(core)
  const result = core.session ? await core.session.drain() : { state: 'stopped' as const }
  await core.enrolling?.done
  return result
}

/**
 * The machine's link to control. Lanes never depend on it: enrollment and
 * removal are state changes here, and only the heartbeat and TCP API follow.
 */
export function createControlLink<T extends LinkEnrollment>(
  ports: ControlLinkPorts<T>,
  initial: T | null,
): ControlLink {
  const core: LinkCore<T> = {
    ports,
    state: { kind: 'local' },
    ending: false,
    stop: new AbortController(),
    wake: signalled(),
    listeners: new Set(),
  }
  return {
    state: () => core.state,
    mode: () => core.state.kind,
    onChange(listener) {
      core.listeners.add(listener)
      return () => core.listeners.delete(listener)
    },
    start() {
      if (initial && !core.session && !core.ending) connect(core, initial)
    },
    reload: () => reload(core),
    beginEnrollment: () => beginEnrollment(core),
    async cancelEnrollment() {
      const current = core.enrolling
      if (!current) return
      current.abort.abort()
      await current.done
    },
    run: () => run(core),
    drain: () => drain(core),
    exitCode: () => 0,
  }
}
