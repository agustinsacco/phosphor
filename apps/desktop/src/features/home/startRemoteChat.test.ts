import type * as RemoteLanesModule from '@/stores/remoteLanes'
import { beforeEach, expect, it, vi } from 'vitest'
import { startRemoteChat } from './startRemoteChat'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
const { adopt, pi, control } = vi.hoisted(() => ({ adopt: vi.fn(), pi: vi.fn(), control: vi.fn() }))
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: { getState: () => ({ claimNav: () => 1 }) },
}))
vi.mock('@/stores/remoteLanes', async (original) => ({
  ...(await original<typeof RemoteLanesModule>()),
  adoptRemoteLane: adopt,
  canControlSession: control,
}))
vi.mock('@/lib/rpc', () => ({ piCallOk: pi }))
const invoke = vi.fn()
const accepted = vi.fn()
const input = { repositoryId: 'repo', provider: 'provider', model: 'model', thinkingLevel: 'high' }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { phosphor: { invoke } })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts) })
  control.mockReturnValue(true)
  adopt.mockResolvedValue(undefined)
  pi.mockResolvedValue(true)
  invoke.mockImplementation(async (channel) =>
    channel === 'hosts:snapshot' ? mockRemoteHosts : mockRemoteInfo,
  )
})
it('creates with Host choices, opens and sends before clearing the draft', async () => {
  pi.mockImplementation(async () => {
    expect(accepted).not.toHaveBeenCalled()
    return true
  })
  await startRemoteChat(MOCK_HOST_ID, input, 'First prompt', [], accepted)
  expect(invoke).toHaveBeenCalledWith('hosts:createLane', MOCK_HOST_ID, input)
  expect(adopt).toHaveBeenCalledWith(mockRemoteInfo, 1)
  expect(pi).toHaveBeenCalledWith(mockRemoteInfo.sessionId, {
    type: 'prompt',
    message: 'First prompt',
    images: [],
  })
  expect(accepted).toHaveBeenCalledOnce()
})
it.each(['down', 'capability', 'viewer', 'receipt', 'transport'])(
  'keeps the draft on %s and never falls back to a local lane',
  async (failure) => {
    if (failure === 'down') useRemoteLanesStore.setState({ hosts: {} })
    if (failure === 'capability')
      useRemoteLanesStore.setState({
        hosts: { [MOCK_HOST_ID]: { ...mockRemoteHosts[MOCK_HOST_ID]!, capabilities: [] } },
      })
    if (failure === 'viewer') control.mockReturnValue(false)
    if (failure === 'receipt') pi.mockResolvedValue(false)
    if (failure === 'transport') invoke.mockRejectedValue(new Error())
    await expect(startRemoteChat(MOCK_HOST_ID, input, 'Keep draft', [], accepted)).rejects.toThrow()
    expect(accepted).not.toHaveBeenCalled()
    expect(invoke.mock.calls.some(([channel]) => String(channel).startsWith('pi:'))).toBe(false)
    if (failure === 'viewer') expect(pi).not.toHaveBeenCalled()
  },
)
