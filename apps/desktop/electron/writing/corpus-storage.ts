import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface CorpusState {
  prompts: string[] | null
  /** Lines in the file, which can run ahead of `prompts` until a rewrite. */
  fileLines: number
  /**
   * The file ends mid-line (a crash during an append). The next append starts
   * a new line first, or it would be glued onto the torn one and lost with it.
   */
  torn: boolean
  chain: Promise<unknown>
}

export async function loadCorpus(
  state: CorpusState,
  filePath: () => string,
  limit: number,
): Promise<string[]> {
  if (state.prompts) return state.prompts
  let raw = ''
  try {
    raw = await readFile(filePath(), 'utf8')
  } catch {
    // No file yet: nothing learned.
  }
  state.torn = raw !== '' && !raw.endsWith('\n')
  const lines = raw.split('\n').filter((line) => line.trim() !== '')
  state.fileLines = lines.length
  state.prompts = lines.flatMap((line) => {
    try {
      const entry: unknown = JSON.parse(line)
      const text = (entry as { t?: unknown }).t
      return typeof text === 'string' && text ? [text] : []
    } catch {
      // A torn last line from a crash mid-append; skip it.
      return []
    }
  })
  state.prompts = state.prompts.slice(-limit)
  return state.prompts
}

const line = (text: string): string => JSON.stringify({ t: text, at: Date.now() }) + '\n'

export async function appendPrompt(
  state: CorpusState,
  filePath: () => string,
  limit: number,
  text: string,
): Promise<void> {
  const prompts = await loadCorpus(state, filePath, limit)
  const prompt = text.trim()
  prompts.push(prompt)
  if (prompts.length > limit) prompts.splice(0, prompts.length - limit)
  const path = filePath()
  await mkdir(dirname(path), { recursive: true })
  if (state.fileLines + 1 > limit * 2) {
    const temp = `${path}.tmp`
    await writeFile(temp, prompts.map(line).join(''), { mode: 0o600 })
    await rename(temp, path)
    state.fileLines = prompts.length
    state.torn = false
  } else {
    // Prompts can be private; the file is the user's alone.
    await appendFile(path, (state.torn ? '\n' : '') + line(prompt), { mode: 0o600 })
    state.fileLines += 1
    state.torn = false
  }
}

export async function clearCorpus(state: CorpusState, filePath: () => string): Promise<void> {
  state.prompts = []
  state.fileLines = 0
  state.torn = false
  await rm(filePath(), { force: true })
}
