import type { BrainStatus } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainApi } from '../types'
import type { Defrag } from './defrag'

/** Defrag's channels. The old Tidy run channels start and stop Defrag until they are removed. */
export function defragApi(
  store: Pick<BrainStore, 'latestRun' | 'undoRun'>,
  defrag: Defrag,
  status: () => BrainStatus,
  mutate: (run: () => void) => Promise<BrainStatus>,
): Pick<BrainApi, 'defrag' | 'defragStop' | 'undoRun' | 'tidyRun' | 'tidyCancel'> {
  const start = async (): Promise<BrainStatus> => {
    defrag.start()
    return status()
  }
  const stop = async (): Promise<BrainStatus> => {
    defrag.stop()
    return status()
  }
  return {
    defrag: start,
    defragStop: stop,
    tidyRun: start,
    tidyCancel: stop,
    undoRun: async (id) => {
      const latest = store.latestRun()
      if (latest?.id === id && (latest.state === 'queued' || latest.state === 'running'))
        throw new Error('Wait for Defrag to finish before undoing its run.')
      let result = { undone: 0, kept: 0 }
      const next = await mutate(() => {
        result = store.undoRun(id)
      })
      return { ...next, ...result }
    },
  }
}
