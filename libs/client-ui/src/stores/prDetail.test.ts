import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prDetail, prRef } from '@/features/sessions/__fixtures__/pullRequests'
import { prDetailOf, usePrDetailStore } from './prDetail'

const key = 'github.com/agustinsacco/phosphor#57'
const invoke = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  vi.stubGlobal('window', { phosphor: { invoke } })
  usePrDetailStore.setState({ byKey: {} })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('loads once for concurrent callers and reuses a fresh read', async () => {
  invoke.mockResolvedValue(prDetail())
  await Promise.all([
    usePrDetailStore.getState().load(prRef(57)),
    usePrDetailStore.getState().load(prRef(57)),
  ])
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith('gh:prDetail', prRef(57), undefined)
  await usePrDetailStore.getState().load(prRef(57))
  expect(invoke).toHaveBeenCalledTimes(1)
  await usePrDetailStore.getState().load(prRef(57), { force: true })
  expect(invoke).toHaveBeenLastCalledWith('gh:prDetail', prRef(57), { force: true })
})

it('keeps the last detail through a failure and says it failed', async () => {
  invoke.mockResolvedValueOnce(prDetail())
  await usePrDetailStore.getState().load(prRef(57))
  invoke.mockRejectedValueOnce(new Error('offline'))
  await usePrDetailStore.getState().load(prRef(57), { force: true })
  const entry = prDetailOf(usePrDetailStore.getState(), key)
  expect(entry).toMatchObject({ failed: true, loading: false })
  expect(entry.detail?.threads).toHaveLength(4)
})

it('returns the shared empty entry for an unknown PR', () => {
  expect(prDetailOf(usePrDetailStore.getState(), undefined)).toBe(
    prDetailOf(usePrDetailStore.getState(), 'nope'),
  )
})
