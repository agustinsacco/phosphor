import { expect, it } from 'vitest'
import { mapLimit } from './map-limit'

it('preserves input order with bounded concurrency', async () => {
  let active = 0
  let peak = 0
  const result = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
    peak = Math.max(peak, ++active)
    await Promise.resolve()
    active--
    return value * 2
  })
  expect(result).toEqual([2, 4, 6, 8, 10])
  expect(peak).toBe(2)
})

it('drains already started work before reporting failure', async () => {
  let release!: () => void
  let finished = false
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const result = mapLimit([1, 2], 2, async (value) => {
    if (value === 1) throw new Error('failed')
    await pending
    finished = true
  })
  const assertion = expect(result).rejects.toThrow('failed')
  await Promise.resolve()
  expect(finished).toBe(false)
  release()
  await assertion
  expect(finished).toBe(true)
})

it('accepts empty work and rejects invalid bounds', async () => {
  expect(await mapLimit([], 4, async () => 0)).toEqual([])
  await expect(mapLimit([1], 0, async () => 0)).rejects.toThrow('Invalid concurrency')
})
