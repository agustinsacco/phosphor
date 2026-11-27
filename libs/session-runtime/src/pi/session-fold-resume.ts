import {
  cloneFold,
  emptyFold,
  foldLine,
  readLinesFrom,
  readSignature,
  type FoldState,
} from './session-fold'

/** Insertion-ordered Map used as an LRU: re-set on hit, evict from the front. */
export function touchLru<V>(cache: Map<string, V>, key: string, value: V, cap: number): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > cap) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

interface Resume {
  consumedBytes: number
  signature: string
  state: FoldState
}

/**
 * Folds of session files that continue where the last one stopped when the
 * file only grew. Desktop's sidebar scan and the Host's lane PR fold share it.
 */
export interface ResumableFolds {
  /**
   * Fold `path` (now `size` bytes) and hand the state to `finish`. A null
   * answer from `finish` is returned without keeping a resume for the file.
   * Anything that throws while resuming falls back to a fold from the start;
   * a throw from that fold is the caller's.
   */
  fold<T>(
    path: string,
    size: number,
    finish: (state: FoldState) => Promise<T>,
  ): Promise<T>
  /** Drop the file's resume, as when it is deleted. */
  forget(path: string): void
  clear(): void
}

/**
 * Keep up to `capacity` resumable folds; each holds a set that grows with its
 * transcript, so only a few. A read past `maxBytes` throws.
 *
 * The append is PROVEN, not assumed: the bytes ending where the last fold
 * stopped are re-read and compared. A rewrite, a truncation, or anything else
 * that moves that boundary folds from the start, so the worst case is the old
 * cost and never a wrong answer.
 */
export function createResumableFolds(capacity: number, maxBytes = Infinity): ResumableFolds {
  const resumes = new Map<string, Resume>()
  const readFrom = (path: string, start: number, state: FoldState) =>
    readLinesFrom(path, start, (line) => foldLine(state, line), maxBytes)

  async function remember<T>(
    path: string,
    state: FoldState,
    consumedBytes: number,
    finish: (state: FoldState) => Promise<T>,
  ): Promise<T> {
    const value = await finish(state)
    if (value === null) return value
    const signature = await readSignature(path, consumedBytes)
    if (signature !== null) touchLru(resumes, path, { consumedBytes, signature, state }, capacity)
    return value
  }

  return {
    async fold(path, size, finish) {
      const resume = resumes.get(path)
      // `size > consumedBytes` is load-bearing, not an optimization. Reaching
      // here means the file changed, so a file that did NOT grow was rewritten
      // in place, and a same-length rewrite can leave the signature bytes
      // untouched. Requiring new bytes sends that case to a full fold.
      if (resume && size > resume.consumedBytes) {
        if ((await readSignature(path, resume.consumedBytes)) === resume.signature) {
          // Fold into a copy: a throw partway through would otherwise leave
          // the kept state double-counted for every later turn.
          const state = cloneFold(resume.state)
          try {
            const consumed = await readFrom(path, resume.consumedBytes, state)
            return await remember(path, state, consumed, finish)
          } catch {
            // Fold from the start below.
          }
        }
      }
      resumes.delete(path)
      const state = emptyFold()
      const consumed = await readFrom(path, 0, state)
      return remember(path, state, consumed, finish)
    },
    forget(path) {
      resumes.delete(path)
    },
    clear() {
      resumes.clear()
    },
  }
}
