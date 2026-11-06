import { afterEach, expect, it, vi } from 'vitest'
import { abortable, EmbeddingClient, type EmbeddingProcess } from './embedding-client'
import type { FromEmbeddingWorker, ToEmbeddingWorker } from './embedding-protocol'

class Process implements EmbeddingProcess {
  posted: ToEmbeddingWorker[] = []
  killed = 0
  reply: (message: FromEmbeddingWorker) => void = () => undefined
  exit: () => void = () => undefined
  post(message: ToEmbeddingWorker): void {
    this.posted.push(message)
  }
  onMessage(listener: (message: FromEmbeddingWorker) => void): void {
    this.reply = listener
  }
  onExit(listener: () => void): void {
    this.exit = listener
  }
  kill(): void {
    this.killed++
    this.exit()
  }
}

function setup() {
  const process = new Process()
  const closed = vi.fn()
  return { process, closed, client: new EmbeddingClient(process, closed) }
}
afterEach(() => vi.useRealTimers())

it('gives each request its own id and settles it by that id only', async () => {
  const { process, client } = setup()
  const first = client.request({ type: 'embed', texts: ['a'] }, 1000)
  const second = client.request({ type: 'embed', texts: ['b'] }, 1000)
  expect(process.posted.map((message) => message.id)).toEqual([1, 2])
  process.reply({ type: 'vectors', id: 2, vectors: [[2]] })
  process.reply({ type: 'error', id: 1, message: 'bad input' })
  await expect(second).resolves.toEqual({ type: 'vectors', id: 2, vectors: [[2]] })
  await expect(first).rejects.toThrow('bad input')
  // A late or unknown reply is ignored.
  process.reply({ type: 'vectors', id: 9, vectors: [] })
})

it('kills the process and fails everything pending when a request times out', async () => {
  vi.useFakeTimers()
  const { process, client, closed } = setup()
  const slow = client.request({ type: 'embed', texts: ['a'] }, 1000)
  const other = client.request({ type: 'embed', texts: ['b'] }, 60_000)
  const failures = Promise.allSettled([slow, other])
  vi.advanceTimersByTime(1000)
  const [a, b] = await failures
  expect(a).toMatchObject({ status: 'rejected', reason: { message: expect.stringMatching(/1 s/) } })
  expect(b).toMatchObject({ status: 'rejected', reason: { message: /timed out/ } })
  expect(process.killed).toBe(1)
  expect(closed).toHaveBeenCalledWith('The embedding process timed out')
  expect(client.alive).toBe(false)
  await expect(client.request({ type: 'embed', texts: [] }, 1000)).rejects.toThrow(/timed out/)
})

it('fails pending requests when the process exits, and clears their timers', async () => {
  vi.useFakeTimers()
  const { process, client } = setup()
  const pending = client.request({ type: 'embed', texts: ['a'] }, 1000)
  process.exit()
  await expect(pending).rejects.toThrow('The embedding process exited')
  expect(vi.getTimerCount()).toBe(0)
})

it('an abort fails only its own request and tells the worker to skip it', async () => {
  const { process, client } = setup()
  const controller = new AbortController()
  const aborted = client.request({ type: 'embed', texts: ['a'] }, 1000, controller.signal)
  const kept = client.request({ type: 'embed', texts: ['b'] }, 1000)
  controller.abort()
  await expect(aborted).rejects.toThrow()
  expect(process.posted.at(-1)).toEqual({ type: 'cancel', id: 1 })
  process.reply({ type: 'vectors', id: 2, vectors: [] })
  await expect(kept).resolves.toMatchObject({ id: 2 })
  expect(client.alive).toBe(true)
})

it('refuses an already-aborted signal without posting', async () => {
  const { process, client } = setup()
  await expect(
    client.request({ type: 'embed', texts: ['a'] }, 1000, AbortSignal.abort()),
  ).rejects.toThrow()
  expect(process.posted).toEqual([])
})

it('abortable rejects on abort and otherwise passes the result through', async () => {
  const controller = new AbortController()
  const never = abortable(new Promise<number>(() => undefined), controller.signal)
  controller.abort(new Error('stop'))
  await expect(never).rejects.toThrow('stop')
  await expect(abortable(Promise.resolve(4), new AbortController().signal)).resolves.toBe(4)
})
