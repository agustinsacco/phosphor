import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isVersion } from '@phosphor/shared/control-api'
import { HOST_SIDECARS, parseLocalRunFile, type LocalRunFile } from '@phosphor/shared/host-local'
import type { LocalStatus } from '@phosphor/shared/host-protocol-owner'
import { atomicRecord, readBounded } from '@phosphor/session-runtime/host-install/files'
import { readLocalMode, readSidecar, writeSidecar } from '../config/sidecar'
import { prepareStateDirectory } from '../lanes/state-dir'

export interface RunHealth {
  version: string
  pid: number
  startedAt: number
  acceptedAt: number
}
export function healthWriter(
  directory: string,
  uid: number | undefined,
  version: string,
  now: () => number,
) {
  const startedAt = now()
  let last = -Infinity
  return () => {
    const acceptedAt = now()
    if (acceptedAt - last < 60_000) return
    prepareStateDirectory(directory, uid)
    atomicRecord(
      join(directory, 'run.json'),
      { version, pid: process.pid, startedAt, acceptedAt },
      0o600,
    )
    last = acceptedAt
  }
}
export function readRunHealth(directory: string): RunHealth | null {
  try {
    const value: unknown = JSON.parse(readBounded(join(directory, 'run.json'), 1024))
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      typeof value.version !== 'string' ||
      value.version.length > 80 ||
      !('pid' in value) ||
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      !('startedAt' in value) ||
      typeof value.startedAt !== 'number' ||
      !Number.isSafeInteger(value.startedAt) ||
      value.startedAt < 0 ||
      !('acceptedAt' in value) ||
      typeof value.acceptedAt !== 'number' ||
      !Number.isSafeInteger(value.acceptedAt) ||
      value.acceptedAt < value.startedAt
    )
      return null
    return {
      version: value.version,
      pid: value.pid,
      startedAt: value.startedAt,
      acceptedAt: value.acceptedAt,
    }
  } catch {
    return null
  }
}

/** A heartbeat this recent before the restart must come back after it. */
export const HEARTBEAT_RECENT_MS = 10 * 60_000

/** What the updater reads before it restarts the service, to judge the new one by. */
export interface HealthBaseline {
  /** When the restart began. */
  after: number
  /** The local-mode marker exists, so the new daemon must write `local.json`. */
  local: boolean
  /** The old process had an accepted heartbeat within `HEARTBEAT_RECENT_MS`. */
  heartbeat: boolean
}

export function healthBaseline(
  state: string,
  configDirectory: string,
  uid: number | undefined,
  after: number,
): HealthBaseline {
  let local: boolean
  try {
    local = readLocalMode(configDirectory, uid) !== null
  } catch {
    // A marker that is there but unusable still makes this a local daemon.
    local = true
  }
  const old = readRunHealth(state)
  const heartbeat =
    old !== null && old.acceptedAt <= after && after - old.acceptedAt <= HEARTBEAT_RECENT_MS
  return { after, local, heartbeat }
}

/** `local.json`, which a local daemon writes once its socket accepts connections. */
export function readLocalRun(state: string, uid: number | undefined): LocalRunFile | null {
  const read = readSidecar(state, HOST_SIDECARS.localRun, parseLocalRunFile, { uid })
  return read.state === 'ok' ? read.value : null
}

/**
 * Healthy: a heartbeat accepted by the new version after the restart, as
 * before. A local daemon instead needs `local.json` from the new version after
 * the restart, plus that heartbeat only when the old process had one within
 * ten minutes: an offline or unenrolled Mac passes on the local signal, while
 * a reachable one still rolls back when the new version cannot reach control.
 */
export function restartedHealthy(
  baseline: HealthBaseline,
  version: string,
  state: string,
  uid: number | undefined,
  now: number,
): boolean {
  const fresh = (at: number) => at >= baseline.after && at <= now
  const run = readRunHealth(state)
  const beat = run?.version === version && run.startedAt >= baseline.after && fresh(run.acceptedAt)
  if (!baseline.local) return beat
  const local = readLocalRun(state, uid)
  const ready =
    local?.hostVersion === version && local.startedAt >= baseline.after && fresh(local.localReadyAt)
  return ready && (!baseline.heartbeat || beat)
}

export type UpdateResult = NonNullable<LocalStatus['lastUpdate']>

/** How long the next daemon reports an update's outcome in `machine.local`. */
export const UPDATE_RESULT_TTL_MS = 24 * 60 * 60_000
const UPDATE_RESULT_KEYS = ['version', 'from', 'to', 'outcome', 'at'] as const
const OUTCOMES: readonly UpdateResult['outcome'][] = ['updated', 'rolled-back', 'failed']

function parseUpdateResult(raw: Record<string, unknown>): UpdateResult | null {
  const { version, from, to, outcome, at } = raw
  return version === 1 &&
    isVersion(from) &&
    isVersion(to) &&
    OUTCOMES.some((o) => o === outcome) &&
    typeof at === 'string' &&
    at.length <= 40 &&
    Number.isFinite(Date.parse(at))
    ? { from, to, outcome: outcome as UpdateResult['outcome'], at }
    : null
}

/** `<state>/update-result.json`, for the next daemon. Best effort: an update never fails on it. */
export function writeUpdateResult(state: string, uid: number | undefined, result: UpdateResult) {
  try {
    writeSidecar(
      state,
      HOST_SIDECARS.updateResult,
      { version: 1, ...result },
      { uid, known: UPDATE_RESULT_KEYS },
    )
  } catch {
    // No state folder yet (a service that never ran), or not one this user owns.
  }
}

/** The last update's outcome, for `machine.local`; removed once it is a day old. */
export function readUpdateResult(
  state: string,
  uid: number | undefined,
  now: number,
): UpdateResult | null {
  const read = readSidecar(state, HOST_SIDECARS.updateResult, parseUpdateResult, { uid })
  if (read.state !== 'ok') return null
  if (now - Date.parse(read.value.at) <= UPDATE_RESULT_TTL_MS) return read.value
  try {
    unlinkSync(join(state, HOST_SIDECARS.updateResult))
  } catch {
    // Already gone, or the next read tries again.
  }
  return null
}
