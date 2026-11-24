import type { LocalRuntimeMode } from '@phosphor/shared/ipc'
import type { OwnerKey } from '../daemon/owner-key'
import type { LocalDaemonLocation } from './transport'

/**
 * Who runs This Mac's lanes in this process: Desktop itself (`in-app`) or the
 * local Phosphor service (`daemon`). The launch gate decides it once and it
 * never changes while the process lives. Until then, and in every process
 * where nothing decides, Desktop runs in-app as it always has, so every
 * guard here is inert. Deliberately import-light: `registry.ts` loads it.
 */

/** How Desktop reaches its own service once the launch gate chose daemon mode. */
export interface LocalDaemonAccess {
  location: LocalDaemonLocation
  /** Desktop's owner key (`daemon/owner-key.ts`); rejects when protected storage is unavailable. */
  ownerKey: () => Promise<OwnerKey>
}

export const IN_APP_RUNTIME_REFUSED =
  "The Phosphor service runs this Mac's lanes, so Desktop does not start or edit them itself."

/** An in-app lane spawn, session write or print run, asked for while the service owns This Mac. */
export class InAppRuntimeRefused extends Error {
  readonly action: string

  constructor(action: string) {
    super(IN_APP_RUNTIME_REFUSED)
    this.name = 'InAppRuntimeRefused'
    this.action = action
  }
}

let decided: { mode: 'in-app' } | { mode: 'daemon'; access: LocalDaemonAccess } | undefined
const daemonListeners = new Set<(access: LocalDaemonAccess) => void>()

export function localRuntimeMode(): LocalRuntimeMode {
  return decided?.mode ?? 'in-app'
}

/**
 * The launch gate's decision, once per process. Repeating the same mode is a
 * no-op; changing it throws, because lanes may already run under the first.
 */
export function decideLocalRuntimeMode(
  ...decision: ['in-app'] | ['daemon', LocalDaemonAccess]
): void {
  const [mode] = decision
  if (decided) {
    if (decided.mode !== mode) throw new Error("This Mac's runtime mode is decided once.")
    return
  }
  if (decision[0] === 'in-app') {
    decided = { mode: 'in-app' }
    daemonListeners.clear()
    return
  }
  const access = decision[1]
  decided = { mode: 'daemon', access }
  for (const listener of [...daemonListeners]) listener(access)
  daemonListeners.clear()
}

/** Runs `listener` once daemon mode is decided (at once when it already is); never in-app. */
export function onDaemonMode(listener: (access: LocalDaemonAccess) => void): () => void {
  if (decided?.mode === 'daemon') {
    listener(decided.access)
    return () => {}
  }
  if (decided) return () => {}
  daemonListeners.add(listener)
  return () => daemonListeners.delete(listener)
}

/**
 * The mode guard every in-app spawn, session write and print run passes
 * (`local-machine/boundary.test.ts` lists them). Throws only in daemon mode.
 */
export function assertInAppRuntime(action: string): void {
  if (decided?.mode === 'daemon') throw new InAppRuntimeRefused(action)
}
