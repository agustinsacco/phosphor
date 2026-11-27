import { constants } from 'node:os'
import { setTimeout } from 'node:timers/promises'
import type { startApi } from '../api/server'
import type { createHeartbeat } from '../control/heartbeat'
import type { HostAttachments } from '../features/attachments'
import type { createHostLiveLanes } from '../lanes/live-host'
import type { createLaneCommands } from '../lanes/commands'
import type { createLaneNamer } from '../lanes/naming'
import type { HostStore } from '../lanes/store'
import type { createHostLog } from '../machine/log'
import type { HostWebPush } from '../push/web-push'
import type { HostRoutines } from '../routines/service'
import type { HostRuntime } from '../session/runtime'
import { SHUTDOWN_SIGNALS, type Drainable, type ShutdownSignal } from '../shutdown'
import type { HostTerminals } from '../terminals/service'
import type { RunServices } from './run-services'
import type { RunBrain } from '../brain/run'
import type { OpsService } from '../ops/service'
import type { Reach } from '@phosphor/session-runtime/ops/reach'

/**
 * Shutdown exits as soon as the attached drain ends. A drain that ended before
 * the run lock was released let a Ctrl-C exit inside the release, leaving
 * identity/.run-lock-recovery behind, and every later run refused to start.
 * The drain therefore also waits for the release, for at most this long.
 */
export const RELEASE_WAIT_MS = 3000

/** Runs `step` so a synchronous throw becomes a rejection and cannot skip the steps after it. */
const attempt = async (step: () => unknown): Promise<unknown> => step()
/** Waits for every promise to settle, then returns the first failure in list order. */
async function firstFailure(pending: unknown[]): Promise<PromiseRejectedResult | undefined> {
  const results = await Promise.allSettled(pending)
  return results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
}

/** What run has started so far. Each part is set as it starts; teardown stops and closes them. */
export interface RunParts {
  log?: ReturnType<typeof createHostLog>
  nameLane?: ReturnType<typeof createLaneNamer>
  api?: ReturnType<typeof startApi>
  /** The owner socket's lane connections: closed beside the TCP API, before the store. */
  socketLanes?: { stop(): Promise<void> }
  routines?: HostRoutines
  routinesStop?: Promise<void>
  runtime?: HostRuntime
  runtimeDrain?: ReturnType<HostRuntime['drain']>
  live?: ReturnType<typeof createHostLiveLanes>['live']
  commands?: ReturnType<typeof createLaneCommands>
  terminals?: HostTerminals
  webPush?: HostWebPush
  attachments?: HostAttachments
  store?: HostStore
  release?: () => Promise<void>
  /** Resolves once `machine.owner release` asked run to exit for a restart in standby. */
  restartInStandby?: Promise<void>
  /** Machine services beside the lane service; each is null until built. */
  services?: RunServices
  /** Agent control: its audit connection closes before the store. */
  ops?: OpsService
  /** Machine reach: its sibling connections close with the lanes. */
  reach?: Pick<Reach, 'close'>
  /** The Host's Brain: it stops admitting writes with the lanes and releases before the store. */
  brain?: RunBrain
}

/** The parts of run a signal's drain waits on besides the started ones. */
export interface RunProgress {
  abort(): void
  loop(): ReturnType<typeof createHeartbeat> | undefined
  initialization(): Promise<void> | undefined
}

interface TeardownState {
  startupExit: number
  drains: number
  later?: ShutdownSignal
  released: () => void
  unlocked: Promise<void>
  /** Set before `unlocked` resolves, so a signal's drain fails with it too. */
  failure?: PromiseRejectedResult
}

async function closeAndRelease(parts: RunParts, state: TeardownState) {
  // The stops start together, and nothing closes until all of them have settled.
  const failures = [
    await firstFailure([
      attempt(() => parts.nameLane?.cancel()),
      attempt(() => parts.api?.stop()),
      attempt(() => parts.socketLanes?.stop()),
      attempt(() => (parts.routinesStop ??= parts.routines?.stop())),
      attempt(() => (parts.runtimeDrain ??= parts.runtime?.drain('run finished'))),
      attempt(() => parts.brain?.brain.dispose()),
    ]),
  ]
  // Then one at a time, whatever failed: the store closes only after its last user.
  for (const close of [
    () => parts.commands?.close(),
    () => parts.terminals?.close(),
    () => parts.webPush?.close(),
    () => parts.attachments?.close(),
    () => parts.routines?.close(),
    () => parts.live?.close(),
    () => parts.reach?.close(),
    () => parts.ops?.close(),
    () => parts.store?.close(),
    () => parts.release?.(),
  ])
    failures.push(await firstFailure([attempt(close)]))
  state.failure = failures.find((result) => result !== undefined)
  state.released()
  if (state.failure) {
    state.startupExit = 70
    throw state.failure.reason
  }
}

async function drain(
  parts: RunParts,
  state: TeardownState,
  progress: RunProgress,
  reason: string,
): Promise<{ state: 'stopped' | 'failed' }> {
  if (state.drains++ > 0 && (SHUTDOWN_SIGNALS as readonly string[]).includes(reason))
    state.later = reason as ShutdownSignal
  progress.abort()
  // Settled from the start, so a failed stop is never unhandled, and it
  // still waits for the release below before the drain rejects.
  const stopping = firstFailure([
    attempt(() => parts.nameLane?.cancel()),
    attempt(() => parts.api?.stop()),
    attempt(() => parts.socketLanes?.stop()),
    attempt(() => (parts.routinesStop ??= parts.routines?.stop())),
    attempt(() => {
      if (!parts.runtime) return
      if (!parts.runtimeDrain) parts.runtimeDrain = parts.runtime.drain(reason)
      else void parts.runtime.drain(reason)
      return parts.runtimeDrain
    }),
    attempt(() => parts.brain?.brain.dispose()),
  ])
  let result: { state: 'stopped' | 'failed' }
  const loop = progress.loop()
  if (loop) result = await loop.drain()
  else {
    await progress.initialization()?.catch(() => {})
    result = { state: 'stopped' }
  }
  // Start-up may have created the runtime or routines since: wait for those too.
  const drainingRuntime = parts.runtimeDrain
  const failure = (await stopping) ?? (await firstFailure([drainingRuntime, parts.routinesStop]))
  if (!failure && (await drainingRuntime)?.state === 'failed') result = { state: 'failed' }
  await Promise.race([state.unlocked, setTimeout(RELEASE_WAIT_MS, undefined, { ref: false })])
  // A teardown step that failed after this drain's own stops fails the signal's exit too.
  const failed = failure ?? state.failure
  if (failed) throw failed.reason
  return result
}

/** Run's ordered stops and closes, and the drain target a shutdown signal uses. */
export function createRunTeardown(parts: RunParts) {
  let released: () => void = () => {}
  const unlocked = new Promise<void>((resolve) => {
    released = resolve
  })
  const state: TeardownState = { startupExit: 70, drains: 0, released, unlocked }
  return {
    closeAndRelease: () => closeAndRelease(parts, state),
    /** A start-up that a signal aborted ends cleanly. */
    abortedCleanly() {
      state.startupExit = 0
    },
    drainTarget: (progress: RunProgress): Drainable => ({
      drain: (reason) => drain(parts, state, progress, reason),
      exitCode: (_reason, clean) =>
        !clean
          ? 70
          : state.later
            ? 128 + constants.signals[state.later]
            : (progress.loop()?.exitCode() ?? state.startupExit),
      log: {
        write: (...args) => parts.log?.write(...args),
        hide: () => 'The Host could not finish.',
      },
    }),
  }
}
