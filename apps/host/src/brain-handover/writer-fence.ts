/**
 * The one fence every handover mutation and the startup recovery share. Host processes with
 * different configs can share a state folder, so in-process ordering alone is not enough: each
 * runs only while this process holds the Brain's writer lock (`<state>/brain-writer.lock`), the
 * lock the Brain itself holds for its lifetime. In this process the hold is shared with that
 * Brain, so a handover beside an open Brain never waits on itself; another process's holder
 * refuses at once (`HostBrainWriterBusy`) rather than being waited on. Calls on one state folder
 * still run one at a time, in arrival order. `run` must not call `withHandoverWriter` again.
 */
import { resolve } from 'node:path'
import { type HostBrainWriterBusy, leaseHostBrainWriter } from '../brain/writer-lock'

const queues = new Map<string, Promise<unknown>>()

export function withHandoverWriter<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  const key = resolve(stateDir)
  const next = (queues.get(key) ?? Promise.resolve()).then(async () => {
    const lease = await leaseHostBrainWriter(stateDir)
    try {
      return await run()
    } finally {
      await lease.release()
    }
  })
  const tail = next.catch(() => undefined)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return next
}

/**
 * Why the writer was not this process's, in words a log or the owner can act on without a path:
 * `writer-repair` when a crash left the recovery gate or a folder sits at the lock path.
 */
export function writerRefusalReason(error: HostBrainWriterBusy): 'writer-repair' | 'writer-busy' {
  return error.refusal === 'gate-stuck' || error.refusal === 'directory'
    ? 'writer-repair'
    : 'writer-busy'
}
