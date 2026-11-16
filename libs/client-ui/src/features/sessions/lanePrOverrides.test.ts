// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LANE_PRS_COMMAND as EXTENSION_COMMAND } from '@phosphor/pi-extensions/lane-prs'
import { LANE_PRS_COMMAND, isLanePrsPrompt } from '@shared/lane-prs-command'
import { remoteLaneKey } from '@shared/remote-host'
import { hostLaneSession, MOCK_HOST_ID, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { useLanePrOverridesStore } from '@/stores/lanePrOverrides'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { prRef } from './__fixtures__/pullRequests'
import { HOST_TRACK_NEEDS_UPDATE, RESUME_TO_TRACK, setLanePrOverride } from './lanePrOverrides'
import { TAKE_CONTROL_FIRST } from './remoteLaneActions'

const piCommand = vi.fn()
const PATH = '/s/lane.jsonl'
const URL = 'https://github.com/agustinsacco/Phosphor/pull/57'
const supported = { name: LANE_PRS_COMMAND, source: 'extension' }

function answer(commands: object[] = [supported]): void {
  piCommand
    .mockReset()
    .mockImplementation(async (_id: string, command: { type: string }) =>
      command.type === 'get_commands'
        ? { success: true, data: { commands } }
        : command.type === 'get_state'
          ? { success: true, data: { isStreaming: false } }
          : { success: true, data: { disposition: 'handled' } },
    )
}

beforeEach(() => {
  // @ts-expect-error partial preload
  window.phosphor = { piCommand }
  answer()
  useLanePrOverridesStore.setState({ byLane: {} })
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({
    live: {
      lane: { phosphorId: 'lane', workspacePath: '/repo', diskPath: PATH },
      fresh: { phosphorId: 'fresh', workspacePath: '/repo' },
      remote: {
        phosphorId: 'remote',
        workspacePath: '/remote',
        target: { kind: 'remote', hostId: 'h' },
      },
    },
  })
})

describe('setLanePrOverride', () => {
  it('names the command the bundled extension registers', () => {
    expect(LANE_PRS_COMMAND).toBe(EXTENSION_COMMAND)
    expect(isLanePrsPrompt(`/${EXTENSION_COMMAND} pin ${URL}`)).toBe(true)
  })

  it('checks registration, sends the command and records the write by session file', async () => {
    await setLanePrOverride('lane', 'pin', prRef(57))
    expect(piCommand.mock.calls.map(([id, command]) => [id, command])).toEqual([
      ['lane', { type: 'get_commands' }],
      ['lane', { type: 'prompt', message: `/phosphor-prs pin ${URL}` }],
      ['lane', { type: 'get_state' }],
    ])
    expect(useLanePrOverridesStore.getState().byLane[PATH]).toMatchObject([
      { action: 'pin', ref: prRef(57) },
    ])
  })

  it.each([
    ['a lane that is not open', 'closed', 'Open the lane to track pull requests.'],
    ['a lane with no session file yet', 'fresh', 'Open the lane to track pull requests.'],
    ['a Host lane its Host does not list', 'remote', 'Open the lane to track pull requests.'],
  ])('rejects %s without sending anything', async (_label, sessionId, message) => {
    await expect(setLanePrOverride(sessionId, 'hide', prRef(57))).rejects.toThrow(message)
    expect(piCommand).not.toHaveBeenCalled()
    expect(useLanePrOverridesStore.getState().byLane).toEqual({})
  })

  it.each([
    ['without the extension command', []],
    ['with a same-name prompt template', [{ name: LANE_PRS_COMMAND, source: 'prompt' }]],
  ])('never sends the slash command to a lane %s, which would run a model', async (_l, list) => {
    answer(list)
    await expect(setLanePrOverride('lane', 'pin', prRef(57))).rejects.toThrow(
      "This lane's pi doesn't support tracking yet.",
    )
    expect(piCommand).toHaveBeenCalledTimes(1)
    expect(useLanePrOverridesStore.getState().byLane).toEqual({})
  })

  it('records nothing when pi refuses the command', async () => {
    piCommand.mockImplementation(async (_id: string, command: { type: string }) =>
      command.type === 'get_commands'
        ? { success: true, data: { commands: [supported] } }
        : { success: false, error: 'pi exited' },
    )
    await expect(setLanePrOverride('lane', 'clear', prRef(57))).rejects.toThrow('pi exited')
    expect(useLanePrOverridesStore.getState().byLane).toEqual({})
  })

  it('refuses a ref that is not a pull request', async () => {
    await expect(setLanePrOverride('lane', 'pin', { ...prRef(57), owner: 'a/b' })).rejects.toThrow(
      'not a pull request',
    )
    expect(piCommand).not.toHaveBeenCalled()
  })
})

describe('setLanePrOverride on a Host lane', () => {
  const SESSION = mockRemoteInfo.sessionId
  const KEY = remoteLaneKey(MOCK_HOST_ID, mockRemoteInfo.laneId!)
  type Markers = { prStatus: boolean; prTracking?: boolean }
  /** The lane on a Host announcing `markers`; a current Host announces both. */
  function hostLane(
    options: Parameters<typeof hostLaneSession>[0],
    markers: Markers = { prStatus: true, prTracking: true },
  ): void {
    const { hosts, live } = hostLaneSession(options)
    Object.assign(hosts[MOCK_HOST_ID]!, markers)
    useRemoteLanesStore.setState({ hosts })
    useSessionsStore.setState({ live })
  }

  it('sends the command through the lane it holds and records it by Host and lane', async () => {
    hostLane({ self: true })
    await setLanePrOverride(SESSION, 'hide', prRef(57))
    expect(piCommand.mock.calls.map(([id, command]) => [id, command])).toEqual([
      [SESSION, { type: 'get_commands' }],
      [SESSION, { type: 'prompt', message: `/phosphor-prs hide ${URL}` }],
      [SESSION, { type: 'get_state' }],
    ])
    expect(Object.keys(useLanePrOverridesStore.getState().byLane)).toEqual([KEY])
    expect(useLanePrOverridesStore.getState().byLane[KEY]).toMatchObject([
      { action: 'hide', ref: prRef(57) },
    ])
  })

  const CURRENT: Markers = { prStatus: true, prTracking: true }
  it.each([
    ['another device holds', { self: false }, CURRENT, TAKE_CONTROL_FIRST],
    ['is stopped', { self: true, activity: 'stopped' as const }, CURRENT, RESUME_TO_TRACK],
    ['failed', { self: true, activity: 'failed' as const }, CURRENT, RESUME_TO_TRACK],
    [
      'is on a Host that folds no PRs',
      { self: true },
      { prStatus: false },
      HOST_TRACK_NEEDS_UPDATE,
    ],
    // host-v0.2.80 folds PRs but never reads the file again after a write: Track reverts.
    [
      'is on a Host that never rereads its file after a write',
      { self: true },
      { prStatus: true },
      HOST_TRACK_NEEDS_UPDATE,
    ],
  ])('sends nothing to a Host lane that %s', async (_label, options, markers, message) => {
    hostLane(options, markers)
    await expect(setLanePrOverride(SESSION, 'pin', prRef(57))).rejects.toThrow(message)
    expect(piCommand).not.toHaveBeenCalled()
    expect(useLanePrOverridesStore.getState().byLane).toEqual({})
  })

  it('never sends the slash command to a Host lane whose pi does not list it', async () => {
    hostLane({ self: true })
    answer([{ name: LANE_PRS_COMMAND, source: 'prompt' }])
    await expect(setLanePrOverride(SESSION, 'pin', prRef(57))).rejects.toThrow(
      "This lane's pi doesn't support tracking yet.",
    )
    expect(piCommand).toHaveBeenCalledExactlyOnceWith(SESSION, { type: 'get_commands' })
    expect(useLanePrOverridesStore.getState().byLane).toEqual({})
  })

  it('sends nothing when the lane stops while its commands are read', async () => {
    hostLane({ self: true })
    piCommand.mockImplementation(async (_id: string, command: { type: string }) => {
      hostLane({ self: true, activity: 'stopped' })
      return command.type === 'get_commands'
        ? { success: true, data: { commands: [supported] } }
        : { success: true, data: { disposition: 'handled' } }
    })
    await expect(setLanePrOverride(SESSION, 'pin', prRef(57))).rejects.toThrow(RESUME_TO_TRACK)
    expect(piCommand).toHaveBeenCalledExactlyOnceWith(SESSION, { type: 'get_commands' })
    expect(useLanePrOverridesStore.getState().byLane).toEqual({})
  })

  it('says to resume when the Host refuses the send because the lane stopped', async () => {
    hostLane({ self: true })
    piCommand.mockImplementation(async (_id: string, command: { type: string }) => {
      if (command.type === 'get_commands') return { success: true, data: { commands: [supported] } }
      // Track and Hide never resume a lane: the Host's refusal comes back as it is.
      hostLane({ self: true, activity: 'stopped' })
      return { success: false, error: 'Studio: this lane is stopped.' }
    })
    await expect(setLanePrOverride(SESSION, 'pin', prRef(57))).rejects.toThrow(RESUME_TO_TRACK)
    expect(useLanePrOverridesStore.getState().byLane).toEqual({})
  })
})
