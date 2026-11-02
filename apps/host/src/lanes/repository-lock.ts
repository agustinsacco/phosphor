import { createKeyedLock } from '@phosphor/session-runtime/pi/session-path-lock'

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
  const lock = createKeyedLock()
  return {
    run(root, work, waiting) {
      if (waiting && lock.busy(root)) {
        try {
          waiting()
        } catch {
          // A progress report cannot take or skip the lock.
        }
      }
      return lock.run(root, work)
    },
  }
}
