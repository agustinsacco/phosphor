import { BRAIN_AUTO_RUN_LIMIT_REFUSAL, type BrainAgentRun } from '@phosphor/shared/brain-agent'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { ExtractionQueue } from '../queue'
import type { BrainServiceOptions } from '../types'
import { waitingTotal, type Defrag } from './defrag'
import { plainRefusal } from './refusal'

export interface AutoRun {
  readSaved(): void
  changed(): void
  runEnded(run: BrainAgentRun): void
  dispose(): void
}
export function createAutoRun(ctx: {
  store: Pick<BrainStore, 'snapshot' | 'latestRun' | 'waitingCounts' | 'waitingSignature'>
  queue: Pick<ExtractionQueue, 'accepting'>
  defrag: Pick<Defrag, 'start'>
  options: Pick<BrainServiceOptions, 'agent' | 'now' | 'log'>
  delayMs?: number
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
}): AutoRun {
  const { store, options } = ctx
  const now = options.now ?? Date.now
  const timers = ctx.timers ?? {
    set: setTimeout,
    clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
  let due: number | null = null,
    timer: unknown,
    disposed = false
  let lastSignature: string | null = null,
    cooldown = 0,
    failures = 0
  function busy() {
    const run = store.latestRun()
    return (
      run?.state === 'running' ||
      run?.state === 'queued' ||
      store.snapshot().jobs.some((j) => j.state === 'queued' || j.state === 'running')
    )
  }
  function clear() {
    if (timer !== undefined) timers.clear(timer)
    timer = undefined
  }
  function fire() {
    timer = undefined
    if (disposed || due === null || busy()) return
    due = null // Consume the read before start(), which synchronously broadcasts a change.
    const { prefs } = store.snapshot()
    if (
      !prefs.enabled ||
      !prefs.agentAuto ||
      !ctx.queue.accepting ||
      !options.agent ||
      !waitingTotal(store.waitingCounts()) ||
      store.waitingSignature() === lastSignature
    )
      return
    try {
      ctx.defrag.start({ automatic: true })
    } catch (error) {
      if (!(error instanceof Error && error.message === BRAIN_AUTO_RUN_LIMIT_REFUSAL))
        options.log?.('Automatic Brain check could not start', { error: plainRefusal(error) })
    }
  }
  function changed() {
    clear()
    if (!disposed && due !== null && !busy())
      timer = timers.set(fire, Math.max(0, Math.max(due, cooldown) - now()))
  }
  return {
    readSaved() {
      due = now() + (ctx.delayMs ?? 60_000)
      changed()
    },
    changed,
    runEnded(run) {
      if (!run.automatic || disposed) return
      lastSignature = store.waitingSignature()
      cooldown =
        run.state === 'failed' ? now() + Math.min(6 * 3600000, 600000 * 2 ** failures++) : 0
      if (run.state !== 'failed') failures = 0
      changed()
    },
    dispose() {
      disposed = true
      due = null
      clear()
    },
  }
}
