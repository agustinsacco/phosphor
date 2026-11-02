import type { RepositorySummary } from '@phosphor/shared/host-protocol'

export type GitProbe = (path: string) => Promise<boolean | null>

export interface RepositoryGitOptions {
  /** Absent: never ask git, and list repositories without the field. */
  probe?: GitProbe
  changed(): void
  now?(): number
  /** One answer's wait before it counts as unknown. */
  timeoutMs?: number
  /** Listings inside this window after a round reuse it, unless a folder is new. */
  intervalMs?: number
}

const CONCURRENCY = 8

/**
 * Whether git tracks each configured folder, so clients hide "new branch" where a
 * worktree cannot exist. Listings return the cached answers and ask git again in
 * the background, at most once per `intervalMs` unless a folder is new, eight
 * folders at a time, never twice at once for one folder. A changed answer calls `changed`, which republishes the
 * list; that listing falls inside the window, so it does not ask again.
 *
 * Only a definite answer is stored. An unknown one (git missing, slow, refusing
 * the folder) keeps the last definite answer, so a flaky git cannot flip the
 * field and republish; a folder never answered stays without it.
 */
export function createRepositoryGit(options: RepositoryGitOptions) {
  const { probe } = options
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 10_000
  const answers = new Map<string, boolean>()
  let asked = new Set<string>()
  let finishedAt = -Infinity
  let running = false
  let queued: readonly string[] | null = null
  const askAll = createAsker(timeoutMs)
  // Never rejects: `ask` settles every probe, and `changed` is guarded.
  const refresh = async (paths: readonly string[], run: GitProbe): Promise<void> => {
    if (running) {
      queued = paths
      return
    }
    if (paths.every((path) => asked.has(path)) && now() - finishedAt < intervalMs) return
    running = true
    let differs = false
    try {
      const results = await askAll(paths, run)
      for (const path of [...answers.keys()]) if (!paths.includes(path)) answers.delete(path)
      for (const [path, answer] of results) {
        if (answer === null || answers.get(path) === answer) continue
        answers.set(path, answer)
        differs = true
      }
      asked = new Set(paths)
    } finally {
      running = false
      finishedAt = now()
    }
    if (differs) {
      try {
        options.changed()
      } catch {
        // A failed republish leaves the answers for the next listing.
      }
    }
    const next = queued
    queued = null
    if (next) await refresh(next, run)
  }
  return {
    annotate(repositories: readonly RepositorySummary[]): RepositorySummary[] {
      if (!probe) return [...repositories]
      void refresh(
        repositories.map((repository) => repository.path),
        probe,
      )
      return repositories.map((repository) => {
        const git = answers.get(repository.path)
        return git === undefined ? repository : { ...repository, git }
      })
    },
  }
}

/**
 * Asks git about `paths` eight at a time. An answer slower than `timeoutMs` counts
 * as unknown.
 */
function createAsker(timeoutMs: number) {
  // A timed-out git keeps running (or hangs on a dead mount): ask that folder
  // again only once it has exited, so stuck processes never pile up.
  const inFlight = new Set<string>()
  const ask = (path: string, run: GitProbe) => {
    if (inFlight.has(path)) return Promise.resolve(null)
    inFlight.add(path)
    return new Promise<boolean | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      timer.unref?.()
      const settle = (answer: boolean | null) => {
        inFlight.delete(path)
        clearTimeout(timer)
        resolve(answer)
      }
      run(path).then(settle, () => settle(null))
    })
  }
  return async (paths: readonly string[], run: GitProbe) => {
    const results = new Map<string, boolean | null>()
    let next = 0
    const worker = async () => {
      while (next < paths.length) {
        const path = paths[next++]!
        results.set(path, await ask(path, run))
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, worker))
    return results
  }
}
