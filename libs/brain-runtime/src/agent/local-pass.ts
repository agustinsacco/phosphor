import { setTimeout as yieldTurn } from 'node:timers/promises'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainSearchPort } from '../types'

/** How long one local pass may sweep before Brain Agent starts; the next Defrag continues it. */
const LOCAL_PASS_MS = 2000
const MAX_CHUNKS = 100

/**
 * Defrag's local pass, with no model: bounded sweep chunks, yielding between them, until the
 * sweep is done or about two seconds have passed. Automatic exact-repeat folds land here.
 */
export async function localPass(
  store: Pick<BrainStore, 'sweep'>,
  search: Pick<BrainSearchPort, 'refresh'>,
  signal: AbortSignal,
  now: () => number,
): Promise<{ suggestions: number; folded: number }> {
  const until = now() + LOCAL_PASS_MS
  let suggestions = 0
  let folded = 0
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    signal.throwIfAborted()
    const result = store.sweep('all')
    suggestions += result.suggestions
    folded += result.folded
    if (result.coverage.phase === 'done' || now() >= until) break
    await yieldTurn(0, undefined, { signal })
  }
  if (folded) await search.refresh()
  return { suggestions, folded }
}
