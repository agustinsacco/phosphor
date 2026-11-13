import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GhPrRead, GhPrSummary } from '@shared/models'
import { usePrStatusStore } from './prStatus'

const ref = (number: number) => ({ host: 'github.com', owner: 'o', repo: 'r', number })
const key = (number: number) => `github.com/o/r#${number}`
const summary = (number: number, state: GhPrSummary['state'] = 'OPEN') =>
  ({ number, state, title: 'x', url: `https://github.com/o/r/pull/${number}` }) as GhPrSummary
const found = (numbers: number[], state?: GhPrSummary['state']): GhPrRead => ({
  byKey: Object.fromEntries(numbers.map((n) => [key(n), summary(n, state)])),
  coverage: Object.fromEntries(
    numbers.map((n) => [key(n), { state: 'found', checkedAt: 1, attemptedAt: 1 }]),
  ),
})

const invoke = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  vi.stubGlobal('window', { phosphor: { invoke } })
  usePrStatusStore.setState({ byKey: {} })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('reads in pages of 20, keeps a summary through a failed read, and retries when stale', async () => {
  const refs = Array.from({ length: 25 }, (_, i) => ref(i + 1))
  invoke.mockImplementation(async (_channel, page: typeof refs) => found(page.map((r) => r.number)))
  await usePrStatusStore.getState().refresh(refs)
  expect(invoke.mock.calls.map(([, page]) => page.length)).toEqual([20, 5])
  invoke.mockRejectedValueOnce(new Error('offline'))
  await usePrStatusStore.getState().refresh([ref(1)], { force: true })
  expect(usePrStatusStore.getState().byKey[key(1)]).toMatchObject({
    failed: true,
    summary: { number: 1 },
  })
  await usePrStatusStore.getState().refresh([ref(1)])
  expect(invoke).toHaveBeenCalledTimes(3) // not stale yet
  vi.advanceTimersByTime(60_000)
  await usePrStatusStore.getState().refresh([ref(1)])
  expect(invoke).toHaveBeenCalledTimes(4)
})

it('removes a PR only when GitHub says it does not exist', async () => {
  invoke.mockResolvedValueOnce(found([1]))
  await usePrStatusStore.getState().refresh([ref(1)])
  invoke.mockResolvedValueOnce({
    byKey: {},
    coverage: { [key(1)]: { state: 'absent', checkedAt: 2, attemptedAt: 2 } },
  })
  await usePrStatusStore.getState().refresh([ref(1)], { force: true })
  expect(usePrStatusStore.getState().byKey[key(1)]?.summary).toBeUndefined()
})

it('reads a merged PR once per app run', async () => {
  invoke.mockResolvedValue(found([1], 'MERGED'))
  await usePrStatusStore.getState().refresh([ref(1)])
  vi.advanceTimersByTime(10 * 60_000)
  await usePrStatusStore.getState().refresh([ref(1)])
  expect(invoke).toHaveBeenCalledTimes(1)
})
