import { setTimeout as yieldTurn } from 'node:timers/promises'
import type { BrainTidyRun } from '@phosphor/shared/brain-tidy'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { scrubExcerpt } from '@phosphor/memory-engine/secrets'
import type { BrainSearchPort, BrainServiceOptions } from '../types'
import type { ExtractionQueue } from '../queue'
import { NO_MODEL, tidyCaller, tidyModel } from './check'

/** The engine persists this singleton independently of lane jobs. */
export interface TidyRunState {
  readRun(): BrainTidyRun | null
  writeRun(run: BrainTidyRun): void
}
export interface TidyRunContext {
  store: BrainStore
  search: BrainSearchPort
  options: BrainServiceOptions
  queue: ExtractionQueue
  runState?: TidyRunState
  changed(): void
}
export interface TidyRunner {
  current(): BrainTidyRun | null
  start(): void
  cancel(): void
}
const active = (run: BrainTidyRun | null): boolean =>
  !!run && ['queued', 'sweeping', 'checking'].includes(run.state)
const message = (error: unknown): string =>
  scrubExcerpt(error instanceof Error ? error.message : 'Brain Tidy failed.').slice(0, 300)

async function sweep(
  context: TidyRunContext,
  signal: AbortSignal,
  update: (patch: Partial<BrainTidyRun>) => void,
) {
  const now = context.options.now ?? Date.now
  const until = now() + 2000
  let suggestions = 0,
    folded = 0
  update({ state: 'sweeping', message: 'Looking for repeats locally.' })
  for (let chunk = 0; chunk < 100; chunk++) {
    signal.throwIfAborted()
    const result = context.store.sweep('all')
    suggestions += result.suggestions
    folded += result.folded
    update({ suggestions, folded })
    if (result.coverage.phase === 'done' || now() >= until) break
    await yieldTurn(0, undefined, { signal })
  }
  if (folded) await context.search.refresh()
}

async function check(
  context: TidyRunContext,
  signal: AbortSignal,
  update: (patch: Partial<BrainTidyRun>) => void,
) {
  // Keep only handles across calls: Forget may erase a later batch while a call is in flight.
  const ids = context.store
    .pendingPairs(40)
    .slice(0, 40)
    .map((pair) => pair.suggestionId)
  update({ total: ids.length })
  const model = await tidyModel(context.store, context.options)
  signal.throwIfAborted()
  if (!model) {
    update({ message: NO_MODEL })
    return
  }
  if (!ids.length) {
    update({ message: 'No pairs need a model check.' })
    return
  }
  const call = tidyCaller(context.options, model, signal)
  let checked = 0,
    dropped = 0,
    missing = 0
  for (let offset = 0; offset < ids.length; offset += 8) {
    signal.throwIfAborted()
    update({ state: 'checking', message: `Checking ${checked} of ${ids.length}` })
    const batch = new Set(ids.slice(offset, offset + 8))
    try {
      const result = await call(() =>
        context.store.pendingPairs(40).filter((pair) => batch.has(pair.suggestionId)),
      )
      signal.throwIfAborted()
      context.store.recordVerdicts(result.judgements)
      checked += result.judgements.length
      dropped += result.dropped
      missing += result.missing
      update({ checked, message: `Checking ${checked} of ${ids.length}` })
    } catch (error) {
      if (signal.aborted) throw error
      update({ error: `${message(error)} Retry to check the unjudged pairs.` })
    }
  }
  update({
    message: `Checked ${checked} of ${ids.length} pairs.${dropped ? ` Dropped ${dropped} invalid answers.` : ''}${missing ? ` ${missing} pairs were left unjudged; Retry to check them.` : ''}`,
  })
  if (missing) update({ error: 'Some pairs had no usable verdict. Retry to check them.' })
}

export function createTidyRunner(context: TidyRunContext): TidyRunner {
  const now = context.options.now ?? Date.now
  let run = context.runState?.readRun() ?? null
  let cancel: (() => void) | undefined
  const update = (patch: Partial<BrainTidyRun>): void => {
    if (!run) return
    run = { ...run, ...patch }
    context.runState?.writeRun(run)
    context.changed()
  }
  if (active(run))
    update({
      state: 'failed',
      finishedAt: now(),
      error:
        'Tidy was interrupted when Phosphor closed. Run it again to check the remaining pairs.',
    })
  const execute = async (signal: AbortSignal): Promise<void> => {
    try {
      await sweep(context, signal, update)
      await check(context, signal, update)
      signal.throwIfAborted()
      update({ state: run?.error ? 'failed' : 'done', finishedAt: now() })
    } catch (error) {
      update({
        state: signal.aborted ? 'cancelled' : 'failed',
        error: signal.aborted ? null : message(error),
        finishedAt: now(),
      })
    }
  }
  return {
    current: () => (context.runState ? context.runState.readRun() : run),
    start() {
      if (context.runState) run = context.runState.readRun()
      if (active(run)) return
      if (!context.runState) throw new Error('Brain Tidy persistence is unavailable.')
      if (!context.queue.accepting) throw new Error('Brain is resetting.')
      if (!context.store.snapshot().prefs.enabled)
        throw new Error('Turn on Brain before running Tidy.')
      run = {
        state: 'queued',
        checked: 0,
        total: 0,
        suggestions: 0,
        folded: 0,
        startedAt: now(),
        finishedAt: null,
        message: 'Waiting for the Brain reader.',
        error: null,
      }
      update({})
      const task = context.queue.enqueueTask(execute)
      cancel = task.cancel
      task.done.catch((error: unknown) => {
        update({ state: 'cancelled', message: message(error), finishedAt: now() })
      })
    },
    cancel() {
      cancel?.()
    },
  }
}
