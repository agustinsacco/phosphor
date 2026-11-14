// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LANE_PRS_COMMAND as EXTENSION_COMMAND } from '@phosphor/pi-extensions/lane-prs'
import { useLanePrOverridesStore } from '@/stores/lanePrOverrides'
import { useSessionsStore } from '@/stores/sessions'
import { prRef } from './__fixtures__/pullRequests'
import { LANE_PRS_COMMAND, setLanePrOverride } from './lanePrOverrides'

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
  useLanePrOverridesStore.setState({ byPath: {} })
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
  })

  it('checks registration, sends the command and records the write by session file', async () => {
    await setLanePrOverride('lane', 'pin', prRef(57))
    expect(piCommand.mock.calls.map(([id, command]) => [id, command])).toEqual([
      ['lane', { type: 'get_commands' }],
      ['lane', { type: 'prompt', message: `/phosphor-prs pin ${URL}` }],
      ['lane', { type: 'get_state' }],
    ])
    expect(useLanePrOverridesStore.getState().byPath[PATH]).toMatchObject([
      { action: 'pin', ref: prRef(57) },
    ])
  })

  it.each([
    ['a lane that is not open', 'closed', 'Open the lane to track pull requests.'],
    ['a lane with no session file yet', 'fresh', 'Open the lane to track pull requests.'],
    ['a Host lane', 'remote', 'not available on Host lanes yet'],
  ])('rejects %s without sending anything', async (_label, sessionId, message) => {
    await expect(setLanePrOverride(sessionId, 'hide', prRef(57))).rejects.toThrow(message)
    expect(piCommand).not.toHaveBeenCalled()
    expect(useLanePrOverridesStore.getState().byPath).toEqual({})
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
    expect(useLanePrOverridesStore.getState().byPath).toEqual({})
  })

  it('records nothing when pi refuses the command', async () => {
    piCommand.mockImplementation(async (_id: string, command: { type: string }) =>
      command.type === 'get_commands'
        ? { success: true, data: { commands: [supported] } }
        : { success: false, error: 'pi exited' },
    )
    await expect(setLanePrOverride('lane', 'clear', prRef(57))).rejects.toThrow('pi exited')
    expect(useLanePrOverridesStore.getState().byPath).toEqual({})
  })

  it('refuses a ref that is not a pull request', async () => {
    await expect(setLanePrOverride('lane', 'pin', { ...prRef(57), owner: 'a/b' })).rejects.toThrow(
      'not a pull request',
    )
    expect(piCommand).not.toHaveBeenCalled()
  })
})
