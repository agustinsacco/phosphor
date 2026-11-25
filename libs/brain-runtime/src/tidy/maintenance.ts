import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainSearchPort } from '../types'

/** Same bound the engine applies inside a mutation. */
const BATCH = 128

export interface TidyMaintenanceContext {
  store: Pick<BrainStore, 'takeTidyMaintenance' | 'sweep'>
  search: Pick<BrainSearchPort, 'refresh'>
  /** Tells the app Brain changed; never schedules maintenance again. */
  notify(): void
  log?: (message: string, data?: Record<string, unknown>) => void
}
export interface TidyMaintenance {
  /** Starts draining pending memories after the mutation that left them has returned. */
  schedule(): void
  /** Drops the batches in hand; the store already forgot ids from before the reset. */
  reset(): void
  stop(): Promise<void>
}

const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * Sweeps what a merge, undo or saved read deferred, 128 memories per batch, yielding between
 * batches. A failure or a stop leaves the rest without fingerprints, so Defrag covers them.
 */
export function createTidyMaintenance(context: TidyMaintenanceContext): TidyMaintenance {
  const { store, search, notify, log } = context
  let active: Promise<void> | null = null
  let again = false
  let epoch = 0
  let stopped = false
  async function drain(own: number): Promise<void> {
    let ids: string[] = []
    for (;;) {
      await yieldTurn()
      if (stopped || own !== epoch) return
      if (!ids.length) ids = store.takeTidyMaintenance()
      if (!ids.length) return
      store.sweep({ entityIds: [], memoryIds: ids.splice(0, BATCH) })
      await search.refresh()
      if (stopped || own !== epoch) return
      notify()
    }
  }
  function schedule(): void {
    if (stopped) return
    if (active) {
      again = true
      return
    }
    again = false
    active = drain(epoch)
      .catch((error: unknown) => {
        log?.('Brain Tidy maintenance stopped', {
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      })
      .finally(() => {
        active = null
        if (again) schedule()
      })
  }
  return {
    schedule,
    reset: () => {
      epoch++
    },
    async stop() {
      stopped = true
      await active
    },
  }
}
