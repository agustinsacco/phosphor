import { expect, it, vi } from 'vitest'
import { openFlights } from './openFlight'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

it('joins a repeat open of the same key and lands every caller on the one result', async () => {
  const open = deferred<string>()
  const start = vi.fn(() => open.promise)
  const flights = openFlights<string>()
  const first = flights.run('a', start, (id) => `first:${id}`)
  const second = flights.run('a', start, (id) => `second:${id}`)
  expect(flights.has('a')).toBe(true)
  open.resolve('s1')
  await expect(first).resolves.toBe('first:s1')
  await expect(second).resolves.toBe('second:s1')
  expect(start).toHaveBeenCalledTimes(1)
  expect(flights.has('a')).toBe(false)
})

it('keeps the key until the starting caller has landed, so a click then never starts a second open', async () => {
  const activation = deferred<void>()
  const start = vi.fn(async () => 's1')
  const changes: Array<[string, boolean]> = []
  const flights = openFlights<string>((key, flying) => changes.push([key, flying]))
  const first = flights.run('a', start, async (id) => {
    await activation.promise
    return id
  })
  await vi.waitFor(() => expect(start).toHaveBeenCalled())
  await Promise.resolve()
  // The open has settled; its activation has not.
  const repeat = flights.run('a', start, (id) => id)
  expect(start).toHaveBeenCalledTimes(1)
  activation.resolve()
  await expect(first).resolves.toBe('s1')
  await expect(repeat).resolves.toBe('s1')
  expect(changes).toEqual([
    ['a', true],
    ['a', false],
  ])
})

it('forgets a failed open and one whose landing throws, so the next open starts afresh', async () => {
  const start = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue('s2')
  const flights = openFlights<string>()
  await expect(flights.run('a', start, (id: string) => id)).rejects.toThrow('down')
  expect(flights.has('a')).toBe(false)
  await expect(
    flights.run('a', start, () => {
      throw new Error('gone')
    }),
  ).rejects.toThrow('gone')
  expect(flights.has('a')).toBe(false)
  await expect(flights.run('a', start, (id: string) => id)).resolves.toBe('s2')
  expect(start).toHaveBeenCalledTimes(3)
})

it('runs different keys independently', async () => {
  const start = vi.fn(async () => 'x')
  const flights = openFlights<string>()
  await Promise.all([flights.run('a', start, (v) => v), flights.run('b', start, (v) => v)])
  expect(start).toHaveBeenCalledTimes(2)
})
