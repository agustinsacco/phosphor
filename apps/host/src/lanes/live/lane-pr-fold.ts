import { lstat } from 'node:fs/promises'
import type { LanePrSignals } from '@phosphor/shared/models'
import { laneSignalsForWire, parseLanePrSignals } from '@phosphor/shared/host-protocol-pr-status'
import { withSubagentPrs } from '@phosphor/session-runtime/pi/lane-pr-runs'
import {
  cloneFold,
  emptyFold,
  foldLine,
  readLinesFrom,
  readSignature,
  type FoldState,
} from '@phosphor/session-runtime/pi/session-fold'

/** Reads one lane file's PR signals; undefined when it points at none. Throws when unreadable. */
export type LanePrRead = (sessionFile: string) => Promise<LanePrSignals | undefined>

export const LANE_PR_FOLD_LIMITS = {
  /** Larger session files are not folded: the lane shows its checkout branch's PR only. */
  fileBytes: 64 * 1024 * 1024,
  /** Answers kept by file, re-read only when the file's size or mtime changes. */
  files: 1024,
  /** Resumable folds: each holds a set that grows with its transcript, so only a few. */
  resumes: 16,
} as const

interface Answer {
  mtimeMs: number
  size: number
  signals: LanePrSignals | undefined
}
interface Resume {
  consumedBytes: number
  signature: string
  state: FoldState
}

function touch<V>(cache: Map<string, V>, key: string, value: V, cap: number): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > cap) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/**
 * The fold Desktop's session scan runs (`session-fold.ts`, then the lane's
 * subagent runs through `withSubagentPrs`), for a Host lane's file. A file that
 * only grew continues from where the last fold stopped, proven by the bytes
 * before that point, as the scan does; anything else folds from the start.
 */
export function createLanePrReader(): LanePrRead {
  const answers = new Map<string, Answer>()
  const resumes = new Map<string, Resume>()
  const L = LANE_PR_FOLD_LIMITS

  async function fold(file: string, size: number): Promise<FoldState> {
    const resume = resumes.get(file)
    if (resume && size > resume.consumedBytes) {
      if ((await readSignature(file, resume.consumedBytes)) === resume.signature) {
        const state = cloneFold(resume.state)
        try {
          const consumed = await readLinesFrom(
            file,
            resume.consumedBytes,
            (line) => foldLine(state, line),
            L.fileBytes,
          )
          return await remember(file, state, consumed)
        } catch {
          // Fold from the start below.
        }
      }
    }
    resumes.delete(file)
    const state = emptyFold()
    const consumed = await readLinesFrom(file, 0, (line) => foldLine(state, line), L.fileBytes)
    return remember(file, state, consumed)
  }

  async function remember(file: string, state: FoldState, consumed: number): Promise<FoldState> {
    const signature = await readSignature(file, consumed)
    if (signature !== null)
      touch(resumes, file, { consumedBytes: consumed, signature, state }, L.resumes)
    return state
  }

  return async (file) => {
    const info = await lstat(file)
    const cached = answers.get(file)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      touch(answers, file, cached, L.files)
      return cached.signals
    }
    let signals: LanePrSignals | undefined
    if (info.isFile() && info.size <= L.fileBytes) {
      const state = await fold(file, info.size)
      const folded = await withSubagentPrs(file, state.header?.parentSession, state.prs)
      // What clients would drop never leaves: the summary's other fields still do.
      signals = (folded && parseLanePrSignals(laneSignalsForWire(folded))) ?? undefined
    }
    touch(answers, file, { mtimeMs: info.mtimeMs, size: info.size, signals }, L.files)
    return signals
  }
}
