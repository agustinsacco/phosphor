import { join } from 'node:path'
import type { SessionPush } from '@phosphor/shared/models'
import { parseReleaseStatus, RELEASE_STATUS_KEY } from '@phosphor/pi-extensions/release-status'
import { errnoIs } from '../fs-safety'
import type { StoredLane } from './store'
import { atomicRecord, readBounded } from '../update/files'

const RECORD = 'release-lanes.json'
const RECORD_BYTES = 8192
const MAX_LANES = 64
const FIRST_DELAY_MS = 30_000
const MAX_DELAY_MS = 30 * 60_000
/** A lane up this long has recovered: its next crash starts the backoff over. */
const STEADY_MS = 10 * 60_000
const BOOT_STAGGER_MS = 2_000
const GIVE_UP = 8

export interface ReleaseKeeperOptions {
  directory: string
  store: { getLane(laneId: string): StoredLane | null }
  live: {
    observe(listener: (laneId: string, push: SessionPush) => void): () => void
    sessionFor(laneId: string): string | null
  }
  resumeLane(lane: StoredLane): Promise<void>
  /** True only while the Host takes new work: never restart a lane during a drain. */
  ready(): boolean
  log(event: string, fields?: Record<string, unknown>): void
  now?: () => number
  later?: (work: () => void, ms: number) => void
}

interface Kept {
  failures: number
  upSince: number
  /** A restart is scheduled or under way: exits meanwhile add nothing. */
  pending: boolean
}

type SavedRecord = { version?: unknown; lanes?: unknown } | null

function load(path: string, log: ReleaseKeeperOptions['log']): string[] {
  try {
    const value = JSON.parse(readBounded(path, RECORD_BYTES)) as SavedRecord
    if (value?.version !== 1 || !Array.isArray(value.lanes)) return []
    return value.lanes.filter((id): id is string => typeof id === 'string').slice(0, MAX_LANES)
  } catch (error) {
    // A damaged record costs the keep-alive, never the Host's start.
    if (!errnoIs(error, 'ENOENT')) log('release.keepalive_unreadable', { error: String(error) })
    return []
  }
}

/** Saving the record of kept lanes, and forgetting one with a logged reason. */
function recorder(path: string, lanes: Map<string, Kept>, log: ReleaseKeeperOptions['log']) {
  const save = () => {
    try {
      atomicRecord(path, { version: 1, lanes: [...lanes.keys()] }, 0o600)
    } catch (error) {
      log('release.keepalive_unsaved', { error: String(error) })
    }
  }
  const forget = (laneId: string, reason: string) => {
    if (!lanes.delete(laneId)) return
    save()
    log('release.keepalive_stopped', { laneId, reason })
  }
  return { save, forget }
}

/**
 * The release keep-alive, the one exception to "a lane resumes on its next
 * message". A lane whose release status says release mode is on is recorded,
 * resumed when the Host starts, and restarted with backoff when pi exits
 * unexpectedly. A deliberate stop while the Host is ready (the user, an account
 * move, a deletion) pauses it until the lane runs again, as does `pause` for a
 * lane the user stops after it crashed. It never calls a model.
 */
export function createReleaseKeeper(options: ReleaseKeeperOptions) {
  const path = join(options.directory, RECORD)
  const now = options.now ?? Date.now
  const later =
    options.later ?? ((work: () => void, ms: number) => void setTimeout(work, ms).unref())
  const lanes = new Map<string, Kept>(
    load(path, options.log).map((id) => [id, { failures: 0, upSince: now(), pending: true }]),
  )
  const { save, forget } = recorder(path, lanes, options.log)
  // A restart belongs to the record that scheduled it: pausing the lane cancels it.
  const restart = (laneId: string, kept: Kept) => {
    kept.pending = false
    if (lanes.get(laneId) !== kept || !options.ready() || options.live.sessionFor(laneId) !== null)
      return
    const lane = options.store.getLane(laneId)
    if (!lane || lane.removedAt !== null || lane.sessionFile === null)
      return forget(laneId, 'lane gone')
    kept.pending = true // A failed start also reports an exit; its error alone counts.
    options.resumeLane(lane).then(
      () => {
        kept.pending = false
        kept.upSince = now()
        options.log('release.keepalive_resumed', { laneId })
      },
      (error: unknown) => {
        kept.pending = false
        options.log('release.keepalive_failed', { laneId, error: String(error) })
        retry(laneId, kept)
      },
    )
  }
  // Crashes and failed resumes share one count, so a crash loop backs off too.
  const retry = (laneId: string, kept: Kept) => {
    if (kept.pending) return
    if (kept.failures >= GIVE_UP) return forget(laneId, 'kept failing')
    kept.pending = true
    const delay = Math.min(FIRST_DELAY_MS * 2 ** kept.failures++, MAX_DELAY_MS)
    later(() => restart(laneId, kept), delay)
  }
  const exited = (laneId: string, expected: boolean) => {
    const kept = lanes.get(laneId)
    if (!kept || !options.ready()) return // A drain keeps the record, so the next start resumes it.
    if (expected) return forget(laneId, 'stopped')
    if (now() - kept.upSince >= STEADY_MS) kept.failures = 0
    retry(laneId, kept)
  }
  const status = (laneId: string, text: string | undefined) => {
    const enabled = parseReleaseStatus(text)?.enabled === true
    if (!enabled) return forget(laneId, 'release mode off')
    if (lanes.has(laneId)) return
    if (lanes.size >= MAX_LANES) return options.log('release.keepalive_full', { laneId })
    lanes.set(laneId, { failures: 0, upSince: now(), pending: false })
    save()
  }
  options.live.observe((laneId, push) => {
    if (push.kind === 'exit') exited(laneId, push.expected)
    else if (
      push.kind === 'extension-ui' &&
      push.request.method === 'setStatus' &&
      push.request.statusKey === RELEASE_STATUS_KEY
    )
      status(laneId, push.request.statusText)
  })
  ;[...lanes].forEach(([laneId, kept], index) =>
    later(() => restart(laneId, kept), BOOT_STAGGER_MS * (index + 1)),
  )
  return {
    lanes: () => [...lanes.keys()],
    /** The user stopped this lane: keep it down, even if it had already crashed. */
    pause: (laneId: string) => forget(laneId, 'stopped'),
  }
}
