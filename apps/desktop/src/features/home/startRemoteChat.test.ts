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

it('retries only definitive fresh collisions with the next bounded candidate', async () => {
  invoke.mockImplementation(async (channel, _host, input) => {
    if (channel === 'hosts:createLane' && input.worktree.branch === 'phosphor/fix-bug')
      throw new Error("Error invoking remote method 'hosts:createLane': Error: branch-exists")
    return channel === 'hosts:snapshot' ? mockRemoteHosts : mockRemoteInfo
  })
  await startRemoteChat(
    MOCK_HOST_ID,
    { ...input, worktree: { branch: 'phosphor/fix-bug', fresh: true } },
    'Fix bug',
    [],
    accepted,
  )
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'hosts:createLane')
      .map((args) => args[2].worktree),
  ).toEqual([
    { branch: 'phosphor/fix-bug', fresh: true },
    { branch: 'phosphor/fix-bug-2', fresh: true },
  ])
  expect(adopt).toHaveBeenCalledOnce()
})

it.each(['branch-exists', 'unknown-outcome'])(
  'bounds retries and retains the draft after %s',
  async (code) => {
    invoke.mockRejectedValue(new Error(code))
    await expect(
      startRemoteChat(
        MOCK_HOST_ID,
        { ...input, worktree: { branch: 'phosphor/fix-bug', fresh: true } },
        'Fix bug',
        [],
        accepted,
      ),
    ).rejects.toThrow(code === 'branch-exists' ? 'branch-name-exhausted' : code)
    const attempts = invoke.mock.calls.filter(([channel]) => channel === 'hosts:createLane')
    expect(attempts).toHaveLength(code === 'branch-exists' ? 5 : 1)
    if (code === 'branch-exists')
      expect(attempts.at(-1)?.[2].worktree.branch).toBe('phosphor/fix-bug-5')
    expect(accepted).not.toHaveBeenCalled()
    expect(adopt).not.toHaveBeenCalled()
  },
)
