import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { forgetHostProviders, readHostProviders } from './hostProvidersCache'
import { useRemoteLanesStore } from './remoteLanes'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  invoke = vi.fn(async () => ({ section: 'providers', revision: 'r', providers: { accounts: [] } }))
  vi.stubGlobal('window', { phosphor: { invoke } })
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: mockRemoteHosts[MOCK_HOST_ID]! } })
})

afterEach(() => {
  forgetHostProviders(MOCK_HOST_ID)
  vi.unstubAllGlobals()
})

it('shares one read between concurrent callers and keeps it for a minute', async () => {
  await Promise.all([readHostProviders(MOCK_HOST_ID, 0), readHostProviders(MOCK_HOST_ID, 0)])
  await readHostProviders(MOCK_HOST_ID, 59_999)
  expect(invoke).toHaveBeenCalledTimes(1)
  await readHostProviders(MOCK_HOST_ID, 60_000)
  expect(invoke).toHaveBeenCalledTimes(2)
})

it('reads again on a new connection', async () => {
  await readHostProviders(MOCK_HOST_ID, 0)
  const host = mockRemoteHosts[MOCK_HOST_ID]!
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: { ...host, connectionToken: 'next' } } })
  await readHostProviders(MOCK_HOST_ID, 1)
  expect(invoke).toHaveBeenCalledTimes(2)
})

it('keeps no failed read, and forgets on request', async () => {
  invoke.mockRejectedValueOnce(new Error('not confirmed'))
  await expect(readHostProviders(MOCK_HOST_ID, 0)).rejects.toThrow('not confirmed')
  await readHostProviders(MOCK_HOST_ID, 1)
  expect(invoke).toHaveBeenCalledTimes(2)
  forgetHostProviders(MOCK_HOST_ID)
  await readHostProviders(MOCK_HOST_ID, 2)
  expect(invoke).toHaveBeenCalledTimes(3)
})

it('refuses an answer without provider settings', async () => {
  invoke.mockResolvedValueOnce({ section: 'providers', revision: 'r' })
  await expect(readHostProviders(MOCK_HOST_ID, 0)).rejects.toThrow('no provider settings')
})
