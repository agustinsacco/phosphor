import type { LanePrSignals } from '@phosphor/shared/models'
import type { LanePrRead } from './lane-pr-fold'

export interface LanePrSignalsOptions {
  read: LanePrRead
  /** Lanes whose signals changed, batched; each needs its summary published again. */
  changed(laneIds: string[]): void
  now?(): number
  /** One lane's file is checked at most this often; a request inside the window runs at its end. */
  intervalMs?: number
  /** Lanes read at once. */
  concurrency?: number
  /** Lanes remembered; the oldest are dropped past this. */
  lanes?: number
}

interface Lane {
  file: string
  signals?: LanePrSignals
  checkedAt: number
  timer?: ReturnType<typeof setTimeout>
  queued: boolean
  running: boolean
  dirty: boolean
}

const BATCH_MS = 200

function unref<T>(timer: T): T {
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}

/** Collects lane ids for `BATCH_MS`, then hands them over at once. */
function batched(changed: (laneIds: string[]) => void) {
  let pending = new Set<string>()
  let flush: ReturnType<typeof setTimeout> | undefined
  return (laneId: string): void => {
    pending.add(laneId)
    flush ??= unref(
      setTimeout(() => {
        const ids = [...pending]
        pending = new Set()
        flush = undefined
        try {
          changed(ids)
        } catch {
          // A failed publish leaves the answers for the next summary.
        }
      }, BATCH_MS),
    )
  }
}

/** Runs queued work `concurrency` at a time. Each task handles its own failures. */
function limited(concurrency: number) {
  const queue: (() => Promise<void>)[] = []
  let active = 0
  const pump = (): void => {
    while (active < concurrency && queue.length) {
      active++
      void queue.shift()!().finally(() => {
        active--
        pump()
      })
    }
  }
  return (task: () => Promise<void>): void => {
    queue.push(task)
    pump()
  }
}

/**
 * A Host lane summary's `pullRequests`, read from its session file in the
 * background. Summaries are built synchronously, so `signalsFor` answers from
 * what was last read and asks for a fresh read: at most one per lane per
 * `intervalMs`, a few lanes at a time, and a later read when asked again inside
 * the window, so a lane that settles still gets its last PR. A changed answer
 * calls `changed`; a failed read keeps the last answer.
 */
export function createLanePrSignals(options: LanePrSignalsOptions) {
  const now = options.now ?? Date.now
  const intervalMs = options.intervalMs ?? 5_000
  const cap = options.lanes ?? 2_000
  const lanes = new Map<string, Lane>()
  const announce = batched(options.changed)
  const enqueue = limited(options.concurrency ?? 4)

  async function run(laneId: string, lane: Lane): Promise<void> {
    lane.queued = false
    if (lanes.get(laneId) !== lane) return
    lane.running = true
    let read: { signals: LanePrSignals | undefined } | undefined
    try {
      read = { signals: await options.read(lane.file) }
    } catch {
      // Unreadable now (moved, permissions, mid-rewrite): keep what was known.
    } finally {
      lane.running = false
      lane.checkedAt = now()
    }
    if (lanes.get(laneId) !== lane) return
    if (read && JSON.stringify(read.signals) !== JSON.stringify(lane.signals)) {
      lane.signals = read.signals
      announce(laneId)
    }
    if (lane.dirty) {
      lane.dirty = false
      request(laneId, lane)
    }
  }

  function request(laneId: string, lane: Lane): void {
    if (lane.running) lane.dirty = true
    if (lane.running || lane.timer || lane.queued) return
    const wait = lane.checkedAt + intervalMs - now()
    if (wait > 0) {
      const due = () => {
        lane.timer = undefined
        if (lanes.get(laneId) === lane) request(laneId, lane)
      }
      lane.timer = unref(setTimeout(due, wait))
      return
    }
    lane.queued = true
    enqueue(() => run(laneId, lane))
  }

  function forget(laneId: string): void {
    const lane = lanes.get(laneId)
    if (lane?.timer) clearTimeout(lane.timer)
    lanes.delete(laneId)
  }

  return {
    signalsFor(laneId: string, file: string | null): LanePrSignals | undefined {
      if (file === null) {
        forget(laneId)
        return undefined
      }
      let lane = lanes.get(laneId)
      if (!lane || lane.file !== file) {
        forget(laneId)
        lane = { file, checkedAt: -Infinity, queued: false, running: false, dirty: false }
        lanes.set(laneId, lane)
        while (lanes.size > cap) forget(lanes.keys().next().value!)
      }
      request(laneId, lane)
      return lane.signals
    },
    forget,
  }
}
