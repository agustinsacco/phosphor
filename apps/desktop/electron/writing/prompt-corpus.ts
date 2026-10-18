import { isLearnablePrompt, MAX_LEARNED_PROMPTS } from '@shared/writing'
import { appendPrompt, clearCorpus, loadCorpus, type CorpusState } from './corpus-storage'

/**
 * The prompts autocomplete learns from: one JSON line per sent prompt, in
 * `<userData>/writing/prompts.jsonl`.
 *
 * Phosphor keeps its own list rather than reading pi's session files because
 * those mix in what no person typed. In the last 400 session files on the
 * machine this was built on, the commonest openers were pi-subagents'
 * "Inspect subagent updates above…" (48) and test prompts from temp folders.
 * A prompt only lands here when a composer sends it while autocomplete is on.
 *
 * Appends are cheap and the list is small (2,000 prompts, under 1 MB), so the
 * file is only rewritten when it holds twice the limit. Every operation runs
 * in order on one chain, so a clear cannot interleave with an append.
 */
export interface PromptCorpus {
  list(): Promise<string[]>
  record(text: string): Promise<void>
  clear(): Promise<void>
}

/** `filePath` is a function so callers can resolve userData lazily (see store.ts). */
export function createPromptCorpus(
  filePath: () => string,
  limit = MAX_LEARNED_PROMPTS,
): PromptCorpus {
  const state: CorpusState = {
    prompts: null,
    fileLines: 0,
    torn: false,
    chain: Promise.resolve(),
  }

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = state.chain.then(task, task)
    state.chain = next.catch(() => undefined)
    return next
  }

  return {
    list: () => serial(async () => [...(await loadCorpus(state, filePath, limit))]),

    record: (text) =>
      serial(async () => {
        if (typeof text !== 'string' || !isLearnablePrompt(text)) return
        await appendPrompt(state, filePath, limit, text)
      }),

    clear: () => serial(() => clearCorpus(state, filePath)),
  }
}
