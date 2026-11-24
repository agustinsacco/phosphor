import type { Stats } from 'node:fs'
import type { link } from 'node:fs/promises'
import { isIsoTime } from '@phosphor/shared/control-api'
import {
  acquireRecoveryGate as acquireLinkLockGate,
  reclaimLinkLock,
  releaseLinkLock,
  snapshotLinkLock,
  type LinkLock,
  type LinkLockRefusal,
  type LinkLockSnapshot,
} from '@phosphor/session-runtime/owner-lock/link-lock'
import { readIdentityFileSnapshot } from './identity'

export interface LockPorts {
  pid: number
  isAlive: (pid: number) => boolean
  link?: typeof link
  lstat?: (path: string) => Promise<Stats>
  wait?: (ms: number) => Promise<void>
  now?: () => number
}
export class LockBusy extends Error {
  constructor(pid?: number, message?: string) {
    super(
      message ??
        (pid === undefined
          ? 'Another phosphor login or logout is running.'
          : `Another phosphor login or logout is running (pid ${pid}).`),
    )
  }
}

export interface LockState {
  path: string
  gatePath: string
  token: string
  name: '.lock' | '.run-lock'
  directory: string
  uid: number | undefined
  ports: LockPorts
}

type IdentityLockRecord = NonNullable<ReturnType<typeof parseLock>>
export type LockSnapshot = LinkLockSnapshot<IdentityLockRecord>

export function lockBusy({ name }: LockState, pid?: number, message?: string): LockBusy {
  return new LockBusy(
    pid,
    name === '.lock'
      ? message
      : (message?.replaceAll('login or logout', 'run').replaceAll('.lock', name) ??
          `Another phosphor run is running${pid === undefined ? '.' : ` (pid ${pid}).`}`),
  )
}

function refuseIdentityLock(state: LockState, refusal: LinkLockRefusal<IdentityLockRecord>) {
  switch (refusal.kind) {
    case 'held':
      return lockBusy(state, refusal.holder.pid)
    case 'contended':
      return lockBusy(state)
    case 'gate-stuck':
      return lockBusy(
        state,
        undefined,
        'A crashed phosphor login or logout left identity/.lock-recovery. If none is running, remove it and retry.',
      )
    case 'directory':
      return lockBusy(
        state,
        undefined,
        'Remove the directory identity/.lock, then retry phosphor login or logout.',
      )
  }
}

/** The identity lock as the shared link-lock core sees it. Reads `state` at each call. */
export function identityLinkLock(state: LockState): LinkLock<IdentityLockRecord> {
  return {
    get path() {
      return state.path
    },
    get gatePath() {
      return state.gatePath
    },
    get token() {
      return state.token
    },
    get ports() {
      return state.ports
    },
    read: () => readIdentityFileSnapshot(state.directory, state.uid, state.name),
    parse: parseLock,
    isLive: (holder) => state.ports.isAlive(holder.pid),
    refuse: (refusal) => refuseIdentityLock(state, refusal),
  }
}

export function parseLock(text: string): { pid: number; token: string } | null {
  try {
    const value: unknown = JSON.parse(text)
    if (
      value !== null &&
      typeof value === 'object' &&
      'pid' in value &&
      typeof value.pid === 'number' &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      value.pid <= 2147483647 &&
      'token' in value &&
      typeof value.token === 'string' &&
      /^[0-9a-f]{64}$/.test(value.token) &&
      'startedAt' in value &&
      isIsoTime(value.startedAt)
    )
      return { pid: value.pid, token: value.token }
  } catch {
    /* Malformed locks can be recovered. */
  }
  return null
}

export function acquireRecoveryGate(state: LockState): Promise<void> {
  return acquireLinkLockGate(identityLinkLock(state))
}

export function snapshotLock(state: LockState): Promise<LockSnapshot | null> {
  return snapshotLinkLock(identityLinkLock(state))
}

export function reclaimLock(state: LockState, stale: LockSnapshot | null): Promise<void> {
  return reclaimLinkLock(identityLinkLock(state), stale)
}

export function releaseIdentityLock(state: LockState): Promise<void> {
  return releaseLinkLock(identityLinkLock(state))
}
