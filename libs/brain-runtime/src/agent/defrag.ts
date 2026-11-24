import {
  BRAIN_POSSIBLE_REPEATS_PER_RUN,
  type BrainWaitingCounts,
  type BrainAgentRun,
} from '@phosphor/shared/brain-agent'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { ExtractionQueue } from '../queue'
import type { BrainAgentHost, BrainAgentTurn, BrainSearchPort, BrainServiceOptions } from '../types'
import { localPass } from './local-pass'
import { plainRefusal } from './refusal'

type BrainRunPatch = Parameters<BrainStore['updateRun']>[1]

export const DEFRAG_INTERRUPTED = 'Phosphor closed during Defrag.'

export interface DefragContext {
  store: BrainStore
  search: Pick<BrainSearchPort, 'refresh'>
  options: Pick<BrainServiceOptions, 'agent' | 'now' | 'log'>
  queue: Pick<ExtractionQueue, 'accepting' | 'enqueueTask'>
  runEnded?(run: BrainAgentRun): void
  changed(): void
}
export interface Defrag {
  /** Queues a run behind reads already queued; throws a plain sentence when it cannot. */
  start(options?: { automatic?: boolean }): void
  /** A queued run never starts; a running one stops its turn. Changes so far stay. */
  stop(): void
  /** App shutdown: a run left unfinished is reported as interrupted at the next start. */
  dispose(): void
  /**
   * The run whose message Brain Agent is answering, with the signal Stop aborts: its changes
   * belong to it. Null outside a run, and while the run waits for the owner's own turn in the
   * lane, so what the owner asks for then is theirs. (The run holds Brain's worker the whole
   * time; that is `ExtractionQueue.defragActive`.)
   */
  turnRun(): { runId: string; signal: AbortSignal } | null
}

/** What Defrag decides: the header count. Unchecked pairs alone never start a run. */
export const waitingTotal = (counts: BrainWaitingCounts): number =>
  counts.groups +
  counts.unlinked +
  counts.entities +
  counts.repeats +
  counts.conflicts +
  counts.flags

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

/** What the Brain lane sees when a check starts. */
export function defragMessage(counts: BrainWaitingCounts, possibleRepeats: boolean): string {
  const kinds = [
    counts.entities && plural(counts.entities, 'person or thing', 'people and things'),
    counts.groups && plural(counts.groups, 'group', 'groups'),
    counts.unlinked && plural(counts.unlinked, 'unlinked pair', 'unlinked pairs'),
    counts.repeats && plural(counts.repeats, 'repeat', 'repeats'),
    counts.conflicts && plural(counts.conflicts, 'disagreement', 'disagreements'),
    counts.flags && plural(counts.flags, 'flag', 'flags'),
  ].filter(Boolean)
  const extra = possibleRepeats
    ? `, and up to ${BRAIN_POSSIBLE_REPEATS_PER_RUN} possible repeats`
    : ''
  return `Defrag. ${waitingTotal(counts)} waiting: ${kinds.join(', ')}${extra}. Start with brain_waiting.`
}

/** Whether the local pass left unchecked pairs beside the open suggestions. */
function hasPossibleRepeats(store: BrainStore, counts: BrainWaitingCounts): boolean {
  const open = waitingTotal(counts)
  const page = store.waitingSuggestions(1, BRAIN_POSSIBLE_REPEATS_PER_RUN)
  return (
    page.items.some((item) => item.kind === 'possible_repeat') ||
    page.items.length + page.more > open
  )
}

/** The Brain lane's host when Defrag may start now; otherwise a plain sentence saying why not. */
function defragHost({ store, options, queue }: DefragContext): BrainAgentHost {
  if (!store.snapshot().prefs.enabled) throw new Error('Turn on Brain before running Defrag.')
  const host = options.agent
  if (!host) throw new Error('Defrag runs on Desktop.')
  const latest = store.latestRun()
  if (latest?.state === 'queued') throw new Error('Defrag is already waiting to start.')
  if (latest?.state === 'running') throw new Error('Defrag is already running.')
  if (!waitingTotal(store.waitingCounts())) throw new Error('Nothing is waiting for Defrag.')
  if (!queue.accepting) throw new Error('Brain is resetting.')
  return host
}

/** How a finished turn is recorded on its run. */
function turnPatch(turn: BrainAgentTurn): BrainRunPatch {
  return {
    state: turn.outcome === 'finished' ? 'done' : turn.outcome,
    error:
      turn.outcome === 'failed'
        ? plainRefusal(new Error(turn.error ?? ''), 'Brain Agent stopped before it finished.')
        : null,
    rulesChanged: turn.rulesChanged,
    ...(turn.sessionPath ? { sessionPath: turn.sessionPath } : {}),
  }
}

function saveRun(context: DefragContext, id: string, patch: BrainRunPatch) {
  try {
    context.store.updateRun(id, patch)
  } catch (error) {
    context.options.log?.('Brain Defrag run could not be saved', { error: plainRefusal(error) })
  }
  context.changed()
}

export function createDefrag(context: DefragContext): Defrag {
  const { store, queue, options } = context
  const now = options.now ?? Date.now
  let active: { runId: string; cancel(): void } | undefined
  let turnRun: { runId: string; signal: AbortSignal } | null = null
  let disposed = false

  const update = (id: string, patch: BrainRunPatch) => {
    if (!disposed) saveRun(context, id, patch)
  }
  const finish = (id: string, patch: BrainRunPatch): void =>
    update(id, { error: null, ...patch, finishedAt: now() })

  async function execute(runId: string, host: BrainAgentHost, signal: AbortSignal): Promise<void> {
    update(runId, { state: 'running', startedAt: now() })
    try {
      await localPass(store, context.search, signal, now)
      const counts = store.waitingCounts()
      update(runId, { total: waitingTotal(counts) })
      if (!waitingTotal(counts)) return finish(runId, { state: 'done' })
      const message = defragMessage(counts, hasPossibleRepeats(store, counts))
      const turn = await host.turn(message, signal, {
        opened: (sessionPath) => update(runId, { sessionPath }),
        sending: () => {
          turnRun = { runId, signal }
        },
      })
      finish(runId, turnPatch(turn))
    } catch (error) {
      finish(
        runId,
        signal.aborted
          ? { state: 'stopped' }
          : { state: 'failed', error: plainRefusal(error, 'Defrag failed.') },
      )
    } finally {
      turnRun = null
      const run = !disposed && store.latestRun()
      if (run && run.id === runId) context.runEnded?.(run)
    }
  }

  return {
    start({ automatic = false } = {}) {
      const host = defragHost(context)
      const run = store.createRun(automatic)
      const task = queue.enqueueTask((signal) => execute(run.id, host, signal))
      const handle = { runId: run.id, cancel: task.cancel }
      active = handle
      // Rejected only when the run was cancelled before it started.
      task.done
        .catch(() => {
          if (store.latestRun()?.id === run.id && store.latestRun()?.state === 'queued')
            finish(run.id, { state: 'stopped' })
        })
        .finally(() => {
          if (active === handle) active = undefined
        })
        .catch(() => undefined)
      context.changed()
    },
    stop() {
      const latest = store.latestRun()
      if (!latest || (latest.state !== 'queued' && latest.state !== 'running')) return
      const handle = active?.runId === latest.id ? active : undefined
      handle?.cancel()
      // A queued run never starts. A running one records its stop when its turn ends.
      if (latest.state === 'queued' || !handle) finish(latest.id, { state: 'stopped' })
    },
    dispose() {
      disposed = true
    },
    turnRun: () => turnRun,
  }
}
