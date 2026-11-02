import type * as RemoteLanesModule from '@/stores/remoteLanes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startRemoteChat } from './startRemoteChat'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useStartingChatStore } from '@/stores/startingChat'
import { LANE_STARTED_UNOPENED, PROMPT_UNCONFIRMED } from './remoteStartCodes'
const { adopt, pi, control, swarm } = vi.hoisted(() => ({
  adopt: vi.fn(),
  pi: vi.fn(),
  control: vi.fn(),
  swarm: vi.fn(),
}))
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: { getState: () => ({ claimNav: () => 1 }) },
}))
vi.mock('@/stores/remoteLanes', async (original) => ({
  ...(await original<typeof RemoteLanesModule>()),
  adoptRemoteLane: adopt,
  canControlSession: control,
}))
vi.mock('@/lib/rpc', () => ({ piCallOk: pi }))
vi.mock('@/lib/swarm', () => ({ requestSwarm: swarm }))
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
  swarm.mockResolvedValue(undefined)
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

it('authorizes Swarm on the new Host lane before its first prompt', async () => {
  const order: string[] = []
  swarm.mockImplementation(async () => void order.push('swarm'))
  pi.mockImplementation(async () => {
    order.push('prompt')
    return true
  })
  await startRemoteChat(MOCK_HOST_ID, input, 'Split this up', [], accepted, true)
  expect(swarm).toHaveBeenCalledWith(mockRemoteInfo.sessionId, true)
  expect(order).toEqual(['swarm', 'prompt'])
  expect(accepted).toHaveBeenCalledOnce()
})

it('never sends the first prompt when Swarm could not be turned on', async () => {
  swarm.mockRejectedValue(new Error('Swarm requires pi-subagents'))
  await expect(
    startRemoteChat(MOCK_HOST_ID, input, 'Split this up', [], accepted, true),
  ).rejects.toThrow('swarm-failed')
  expect(pi).not.toHaveBeenCalled()
  expect(accepted).not.toHaveBeenCalled()
})

it('leaves Swarm alone unless the draft chose it', async () => {
  await startRemoteChat(MOCK_HOST_ID, input, 'Plain', [], accepted)
  expect(swarm).not.toHaveBeenCalled()
})

describe('a Host that takes the first prompt with the creation', () => {
  const startHost = () =>
    useRemoteLanesStore.setState({
      hosts: {
        [MOCK_HOST_ID]: { ...structuredClone(mockRemoteHosts[MOCK_HOST_ID]!), laneStart: true },
      },
    })
  const created = (prompted?: boolean) =>
    invoke.mockImplementation(async (channel) =>
      channel === 'hosts:createLane'
        ? { ...mockRemoteInfo, ...(prompted === undefined ? {} : { prompted }) }
        : mockRemoteHosts,
    )
  beforeEach(() => {
    startHost()
    useStartingChatStore.setState({ starting: null, draft: null })
  })

  it('creates and prompts in one request, then opens the lane without sending again', async () => {
    created(true)
    await startRemoteChat(MOCK_HOST_ID, input, 'First prompt', [], accepted)
    expect(invoke).toHaveBeenCalledWith('hosts:createLane', MOCK_HOST_ID, {
      ...input,
      prompt: 'First prompt',
    })
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['hosts:createLane'])
    expect(adopt).toHaveBeenCalledWith(expect.objectContaining({ prompted: true }), 1)
    expect(pi).not.toHaveBeenCalled()
    expect(accepted).toHaveBeenCalledOnce()
  })

  it('clears the draft once the Host ran the prompt, even when opening the lane fails', async () => {
    created(true)
    adopt.mockRejectedValueOnce(new Error('open'))
    await expect(
      startRemoteChat(MOCK_HOST_ID, input, 'First prompt', [], accepted),
    ).rejects.toThrow('open')
    expect(accepted).toHaveBeenCalledOnce()
    expect(pi).not.toHaveBeenCalled()
  })

  it('spends the draft when main reports the Host ran the prompt but the lane did not open', async () => {
    invoke.mockRejectedValueOnce(new Error(LANE_STARTED_UNOPENED))
    await expect(
      startRemoteChat(MOCK_HOST_ID, input, 'First prompt', [], accepted),
    ).rejects.toThrow(LANE_STARTED_UNOPENED)
    expect(accepted).toHaveBeenCalledOnce()
    expect(adopt).not.toHaveBeenCalled()
  })

  it('sends the prompt itself, behind the echo, when the Host says it could not', async () => {
    created(false)
    useStartingChatStore.getState().begin({
      prompt: 'First prompt',
      remote: { hostId: MOCK_HOST_ID, repositoryId: input.repositoryId, draftKey: 'key' },
    })
    adopt.mockImplementation(async () => {
      expect(useStartingChatStore.getState().starting?.remote).toMatchObject({
        sessionId: mockRemoteInfo.sessionId,
        laneId: mockRemoteInfo.laneId,
      })
    })
    await startRemoteChat(MOCK_HOST_ID, input, 'First prompt', [], accepted)
    expect(adopt).toHaveBeenCalledOnce()
    expect(pi).toHaveBeenCalledWith(mockRemoteInfo.sessionId, {
      type: 'prompt',
      message: 'First prompt',
      images: [],
    })
    expect(accepted).toHaveBeenCalledOnce()
  })

  it('never sends twice when the Host does not say whether the prompt went in', async () => {
    created(undefined)
    await expect(
      startRemoteChat(MOCK_HOST_ID, input, 'First prompt', [], accepted),
    ).rejects.toThrow(PROMPT_UNCONFIRMED)
    expect(adopt).toHaveBeenCalledOnce()
    expect(pi).not.toHaveBeenCalled()
    expect(accepted).not.toHaveBeenCalled()
  })

  it('keeps attachments on the upload path, which needs the lane first', async () => {
    created(false)
    const image = { kind: 'image', id: 'i', name: 'a.png', data: 'AA==', mimeType: 'image/png' }
    invoke.mockImplementation(async (channel) =>
      channel === 'hosts:createLane'
        ? mockRemoteInfo
        : channel === 'hosts:uploadAttachments'
          ? []
          : mockRemoteHosts,
    )
    await startRemoteChat(MOCK_HOST_ID, input, 'Look', [image as never], accepted)
    expect(invoke.mock.calls.find(([c]) => c === 'hosts:createLane')?.[2]).not.toHaveProperty(
      'prompt',
    )
    expect(pi).toHaveBeenCalledOnce()
    expect(accepted).toHaveBeenCalledOnce()
  })

  it('leaves free-name retries to the Host', async () => {
    invoke.mockRejectedValue(new Error('branch-exists'))
    await expect(
      startRemoteChat(
        MOCK_HOST_ID,
        { ...input, worktree: { branch: 'phosphor/fix-bug', fresh: true } },
        'Fix bug',
        [],
        accepted,
      ),
    ).rejects.toThrow('branch-name-exhausted')
    expect(invoke.mock.calls.filter(([c]) => c === 'hosts:createLane')).toHaveLength(1)
  })

  it('turns Swarm on in the open lane before sending, never with the creation', async () => {
    created(false)
    const order: string[] = []
    swarm.mockImplementation(async () => void order.push('swarm'))
    pi.mockImplementation(async () => {
      order.push('prompt')
      return true
    })
    await startRemoteChat(MOCK_HOST_ID, input, 'Split this up', [], accepted, true)
    expect(invoke.mock.calls.find(([c]) => c === 'hosts:createLane')?.[2]).not.toHaveProperty(
      'prompt',
    )
    expect(order).toEqual(['swarm', 'prompt'])
    expect(accepted).toHaveBeenCalledOnce()
  })

  it('skips the control round trip when this window already holds the lane', async () => {
    created(false)
    await startRemoteChat(MOCK_HOST_ID, input, 'First prompt', [], accepted)
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['hosts:createLane'])
  })
})
