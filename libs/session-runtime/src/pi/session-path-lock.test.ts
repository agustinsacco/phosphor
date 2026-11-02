import { expect, it, vi } from 'vitest'
import { createKeyedLock, createSessionPathRuntime } from './session-path-lock'

it('keeps lock and cancellation domains independent between owners and paths', async () => {
  const a = createSessionPathRuntime()
  const b = createSessionPathRuntime()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let signal!: AbortSignal
  const started = vi.fn()
  const first = a.openSessionPath('/same', async (s) => {
    signal = s
    started()
    await gate
  })
  await vi.waitFor(() => expect(started).toHaveBeenCalled())
  await b.openSessionPath('/same', async () => {})
  await a.openSessionPath('/other', async () => {})
  b.cancelSessionOpens('/same')
  expect(signal.aborted).toBe(false)
  a.cancelSessionOpens('/same')
  expect(signal.aborted).toBe(true)
  release()
  await first
})

it('cancels active and queued opens, then admits a later operation after rejection', async () => {
  const paths = createSessionPathRuntime()
  const started = vi.fn()
  const first = paths
    .openSessionPath('/session', async (signal) => {
      started()
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }),
      )
    })
    .catch((error: Error) => error.message)
  await vi.waitFor(() => expect(started).toHaveBeenCalled())
  const queued = vi.fn(async () => {})
  const second = paths.openSessionPath('/session', queued).catch((error: Error) => error.name)
  paths.cancelSessionOpens('/session')
  expect(await first).toBe('stopped')
  expect(await second).toBe('AbortError')
  expect(queued).not.toHaveBeenCalled()
  expect(await paths.withSessionPath('/session', async () => 'delete')).toBe('delete')
  expect(await paths.openSessionPath('/session', async () => 'new')).toBe('new')
})

it('runs one key in order past a failure, and frees the key once it is idle', async () => {
  const lock = createKeyedLock()
  const order: string[] = []
  const failing = lock.run('a', async () => {
    order.push('first')
    throw new Error('boom')
  })
  const next = lock.run('a', async () => order.push('second'))
  const other = lock.run('b', async () => order.push('other'))
  expect(lock.busy('a')).toBe(true)
  await expect(failing).rejects.toThrow('boom')
  await Promise.all([next, other])
  expect(order).toEqual(['first', 'other', 'second'])
  expect(lock.busy('a')).toBe(false)
  expect(lock.busy('b')).toBe(false)
})
