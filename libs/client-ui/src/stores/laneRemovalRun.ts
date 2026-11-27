import type { BulkDeleteProgress, LaneDeleteResult } from './laneRemovalState'

/** The sessions store's `bulkDelete`, read and written by the runner alone. */
export interface BulkDeleteSlot {
  read(): BulkDeleteProgress | null
  write(progress: BulkDeleteProgress): void
}

/** Removes one lane; resolves with a note kept on its successful row, throws when it was kept. */
export type RemoveLane<L> = (lane: L) => Promise<string | undefined>

export interface LaneRemovalRun<L extends { path: string; title: string }> {
  archiving?: boolean
  lanes: L[]
  /** Runs once the run owns the progress; a throw here ends the run with no results. */
  prepare(): Promise<RemoveLane<L>>
  /** The row text for a lane that was kept. */
  failureText(error: unknown): string
  /** After the last lane, before the run unlocks: each owner's cleanup and rescan. */
  finish?(results: LaneDeleteResult[]): Promise<void>
}

/**
 * The one bulk Archive/Delete loop, for in-app and Host lanes. It publishes
 * every lane up front with the first as current, removes them one at a time
 * (never in parallel: each lane stops a process and runs git), reads Stop from
 * the store between lanes and never mid-lane, reports each lane's outcome and
 * never retries one. Every settlement unlocks, including a throw from
 * `prepare` or `finish`, which then rejects. A start while another run is going
 * is ignored and resolves null.
 */
export async function runLaneRemoval<L extends { path: string; title: string }>(
  slot: BulkDeleteSlot,
  run: LaneRemovalRun<L>,
): Promise<LaneDeleteResult[] | null> {
  if (slot.read()?.running) return null
  const results: LaneDeleteResult[] = []
  const first = run.lanes[0]
  slot.write({
    archiving: run.archiving,
    total: run.lanes.length,
    done: 0,
    current: first?.title ?? '',
    currentPath: first?.path ?? '',
    lanes: run.lanes.map((lane) => ({ path: lane.path, title: lane.title })),
    results: [],
    running: true,
    cancelled: false,
  })
  // A dismissed summary stays dismissed: only a published run is updated.
  const update = (patch: Partial<BulkDeleteProgress>): void => {
    const progress = slot.read()
    if (progress) slot.write({ ...progress, ...patch })
  }
  const publish = (current: { path: string; title: string }): void =>
    update({
      done: results.length,
      current: current.title,
      currentPath: current.path,
      results: [...results],
    })
  try {
    const removeLane = await run.prepare()
    for (const lane of run.lanes) {
      if (slot.read()?.cancelled) break
      publish(lane)
      try {
        const note = await removeLane(lane)
        results.push({ path: lane.path, title: lane.title, ok: true, ...(note && { error: note }) })
      } catch (error) {
        results.push({
          path: lane.path,
          title: lane.title,
          ok: false,
          error: run.failureText(error),
        })
      }
      publish(lane)
    }
    await run.finish?.(results)
  } finally {
    update({ done: results.length, current: '', currentPath: '', results, running: false })
  }
  return results
}
