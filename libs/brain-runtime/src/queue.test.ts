import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtractionQueue } from './queue'
import { FakeBrainStore, HARBOR_JOB } from './__fixtures__/fake-store'

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
function setup() {
  vi.useFakeTimers()
  const store = new FakeBrainStore()
  const busy = new Set<string>()
  let ready = true
  const changed = vi.fn()
  const runs: { id: string; signal: AbortSignal; finish(): void; fail(): void }[] = []
  const queue = new ExtractionQueue({
    store,
    busy: (path) => busy.has(path),
    ready: () => ready,
    changed,
    now: () => 123,
    run: (job, signal) =>
      new Promise<void>((resolve, reject) => {
        runs.push({
          id: job.id,
          signal,
          finish() {
            store.updateJob(job.id, { state: 'review' })
            resolve()
          },
          fail() {
            reject(new Error('Harbor extraction failed.'))
          },
        })
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
      }),
  })
  const enqueue = (id: string) =>
    store.enqueue(
      { ...HARBOR_JOB, sessionId: id, sessionPath: id },
      busy.has(id) ? 'waiting' : 'queued',
    )
  return {
    store,
    busy,
    runs,
    queue,
    enqueue,
    changed,
    setReady(value: boolean) {
      ready = value
    },
  }
}
afterEach(() => vi.useRealTimers())

describe('ExtractionQueue', () => {
  it('runs oldest queued first, never overlaps, and starts only when the model and prefs are ready', async () => {
    const s = setup()
    s.setReady(false)
    const a = s.enqueue('rina')
    const b = s.enqueue('tom')
    s.queue.kick()
    await flush()
    expect(s.runs).toEqual([])
    s.setReady(true)
    s.queue.kick()
    s.queue.kick()
    await flush()
    expect(s.runs.map((r) => r.id)).toEqual([a.id])
    expect(s.store.job(a.id)).toMatchObject({ state: 'running', startedAt: 123 })
    s.runs[0]!.finish()
    await flush()
    expect(s.runs.map((r) => r.id)).toEqual([a.id, b.id])
    await s.queue.dispose()
  })

  it('rechecks waiting lanes on a 2 second timer and lets another idle lane run', async () => {
    const s = setup()
    s.busy.add('rina')
    const a = s.enqueue('rina')
    const b = s.enqueue('tom')
    s.queue.kick()
    await flush()
    expect(s.runs[0]!.id).toBe(b.id)
    s.busy.delete('rina')
    await vi.advanceTimersByTimeAsync(1999)
    expect(s.store.job(a.id)!.state).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1)
    expect(s.store.job(a.id)!.state).toBe('queued')
    s.runs[0]!.finish()
    await flush()
    expect(s.runs[1]!.id).toBe(a.id)
    await s.queue.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancel aborts the fork, removes waiting and failed jobs, and runs the next job after exit', async () => {
    const s = setup()
    const a = s.enqueue('rina')
    const b = s.enqueue('tom')
    s.queue.kick()
    await flush()
    s.queue.cancel(a.id)
    expect(s.runs[0]!.signal.aborted).toBe(true)
    expect(s.store.job(a.id)).toBeUndefined()
    await flush()
    expect(s.runs[1]!.id).toBe(b.id)
    s.runs[1]!.fail()
    await flush()
    expect(s.store.job(b.id)).toMatchObject({
      state: 'failed',
      finishedAt: 123,
      error: 'Harbor extraction failed.',
    })
    s.queue.cancel(b.id)
    s.busy.add('busy')
    const c = s.enqueue('busy')
    s.queue.kick()
    s.queue.cancel(c.id)
    expect(s.store.snapshot().jobs).toEqual([])
    await s.queue.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dismisses an empty job as done, retaining its leaf fingerprint instead of removing it', async () => {
    const s = setup()
    s.setReady(false)
    const job = s.enqueue('rina')
    s.store.updateJob(job.id, { state: 'empty', memories: 0 })
    const update = vi.spyOn(s.store, 'updateJob')
    const remove = vi.spyOn(s.store, 'removeJob')
    s.queue.cancel(job.id)
    expect(update).toHaveBeenCalledWith(job.id, { state: 'done' })
    expect(remove).not.toHaveBeenCalled()
    expect(s.store.job(job.id)).toMatchObject({ state: 'done', leafId: job.leafId })
    expect(s.store.snapshot().jobs).toEqual([])
    expect(s.changed).toHaveBeenCalled()
    await s.queue.dispose()
  })

  it('disposal aborts without failing/removing the job; the next service requeues it', async () => {
    const s = setup()
    const job = s.enqueue('rina')
    s.queue.kick()
    await flush()
    await s.queue.dispose()
    expect(s.runs[0]!.signal.aborted).toBe(true)
    expect(s.store.job(job.id)!.state).toBe('running')
    s.store.requeueInterrupted()
    expect(s.store.job(job.id)!.state).toBe('queued')
  })
})
