import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isLearnablePrompt, MAX_LEARNED_PROMPTS } from '@shared/writing'

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
  let prompts: string[] | null = null
  /** Lines in the file, which can run ahead of `prompts` until a rewrite. */
  let fileLines = 0
  let chain: Promise<unknown> = Promise.resolve()

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task)
    chain = next.catch(() => undefined)
    return next
  }

  const load = async (): Promise<string[]> => {
    if (prompts) return prompts
    let raw = ''
    try {
      raw = await readFile(filePath(), 'utf8')
    } catch {
      // No file yet: nothing learned.
    }
    const lines = raw.split('\n').filter((line) => line.trim() !== '')
    fileLines = lines.length
    prompts = lines.flatMap((line) => {
      try {
        const entry: unknown = JSON.parse(line)
        const text = (entry as { t?: unknown }).t
        return typeof text === 'string' && text ? [text] : []
      } catch {
        // A torn last line from a crash mid-append; skip it.
        return []
      }
    })
    prompts = prompts.slice(-limit)
    return prompts
  }

  const line = (text: string): string => JSON.stringify({ t: text, at: Date.now() }) + '\n'

  return {
    list: () => serial(async () => [...(await load())]),

    record: (text) =>
      serial(async () => {
        if (typeof text !== 'string' || !isLearnablePrompt(text)) return
        const list = await load()
        const prompt = text.trim()
        list.push(prompt)
        if (list.length > limit) list.splice(0, list.length - limit)
        const path = filePath()
        await mkdir(dirname(path), { recursive: true })
        if (fileLines + 1 > limit * 2) {
          const temp = `${path}.tmp`
          await writeFile(temp, list.map(line).join(''), { mode: 0o600 })
          await rename(temp, path)
          fileLines = list.length
        } else {
          // Prompts can be private; the file is the user's alone.
          await appendFile(path, line(prompt), { mode: 0o600 })
          fileLines += 1
        }
      }),

    clear: () =>
      serial(async () => {
        prompts = []
        fileLines = 0
        await rm(filePath(), { force: true })
      }),
  }
}
