/**
 * Serializes git folder work (worktree add and its undo, branch refs, the exclude
 * file) per repository root inside this process. Lane creations in one repository
 * take turns only for this step; their pi boots overlap.
 */
export interface RepositoryLocks {
  /** Run `work` once earlier work on `root` has settled. `waiting` runs first when it must wait. */
  run<T>(root: string, work: () => Promise<T>, waiting?: () => void): Promise<T>
}

export function createRepositoryLocks(): RepositoryLocks {
  const tails = new Map<string, Promise<unknown>>()
  return {
    async run(root, work, waiting) {
      const previous = tails.get(root)
      if (previous && waiting) {
        try {
          waiting()
        } catch {
          // A progress report cannot take or skip the lock.
        }
      }
      const current = (async () => {
        await previous?.catch(() => undefined)
        return work()
      })()
      tails.set(root, current)
      try {
        return await current
      } finally {
        if (tails.get(root) === current) tails.delete(root)
      }
    },
  }
}
