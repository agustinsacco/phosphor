import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcCommand } from '@shared/rpc'
import { useChatStore } from '@/stores/chat'
import { CLEAR_QUEUE_MIN_PI, dropQueuedEntry, unqueueMessage } from './queueActions'

const piCommand = vi.fn()
const invoke = vi.fn()

/** What `pi:health` reports back for the version gate in the failure path. */
function installedPi(version: string | undefined): void {
  invoke.mockResolvedValue({ ok: true, version, minVersion: '0.84.1' })
}

/** Queue state pi reports when `clear_queue` drains it. */
function drains(steering: string[], followUp: string[]): void {
  piCommand.mockImplementation((_id: string, command: RpcCommand) =>
    command.type === 'clear_queue'
      ? Promise.resolve({ success: true, data: { steering, followUp } })
      : Promise.resolve({ success: true }),
  )
}

function sentAfterDrain(): RpcCommand[] {
  return piCommand.mock.calls
    .map(([, command]) => command as RpcCommand)
    .filter((command) => command.type !== 'clear_queue')
}

beforeEach(() => {
  piCommand.mockReset()
  invoke.mockReset()
  installedPi('0.84.1')
  vi.stubGlobal('window', { phosphor: { piCommand, invoke } })
  useChatStore.setState({ sessions: {} }, false)
})

describe('dropQueuedEntry', () => {
  it('drops the indexed entry when its text still matches', () => {
    expect(dropQueuedEntry(['a', 'b', 'c'], 1, 'b')).toEqual(['a', 'c'])
  })

  it('falls back to the first equal text when the index shifted', () => {
    expect(dropQueuedEntry(['b', 'c'], 2, 'b')).toEqual(['c'])
  })

  it('reports the entry as gone when it is no longer queued', () => {
    expect(dropQueuedEntry(['a'], 0, 'b')).toBeNull()
  })

  it('drops only one of two identical entries', () => {
    expect(dropQueuedEntry(['a', 'a'], 1, 'a')).toEqual(['a'])
  })
})

describe('unqueueMessage', () => {
  it('re-queues every survivor, in order, across both queues', async () => {
    drains(['keep me', 'drop me', 'me too'], ['later'])
    await unqueueMessage('s1', 'steer', 1, 'drop me')
    expect(sentAfterDrain()).toEqual([
      { type: 'steer', message: 'keep me' },
      { type: 'steer', message: 'me too' },
      { type: 'follow_up', message: 'later' },
    ])
    expect(useChatStore.getState().sessions.s1?.error).toBeUndefined()
  })

  it('removes a follow-up without touching the steering queue', async () => {
    drains(['steer'], ['a', 'b'])
    await unqueueMessage('s1', 'follow-up', 0, 'a')
    expect(sentAfterDrain()).toEqual([
      { type: 'steer', message: 'steer' },
      { type: 'follow_up', message: 'b' },
    ])
  })

  it('restores the whole queue and says so when pi already read the message', async () => {
    drains(['other'], [])
    await unqueueMessage('s1', 'steer', 0, 'already gone')
    expect(sentAfterDrain()).toEqual([{ type: 'steer', message: 'other' }])
    expect(useChatStore.getState().sessions.s1?.error).toMatch(/already delivered/)
  })

  it('leaves the queue alone and names both versions when the drain is unsupported', async () => {
    piCommand.mockResolvedValue({ success: false, error: 'Unknown command: clear_queue' })
    await unqueueMessage('s1', 'steer', 0, 'drop me')
    expect(sentAfterDrain()).toEqual([])
    const error = useChatStore.getState().sessions.s1?.error
    expect(error).toMatch(/unchanged/)
    expect(error).toMatch(new RegExp(`needs pi ${CLEAR_QUEUE_MIN_PI.replace(/\./g, '\\.')}`))
    expect(error).toMatch(/this machine has 0\.84\.1/)
    expect(error).toMatch(/npm install -g @earendil-works\/pi-coding-agent/)
  })

  it('still advises an upgrade when the installed version is unknown', async () => {
    piCommand.mockResolvedValue({ success: false, error: 'Unknown command: clear_queue' })
    invoke.mockRejectedValue(new Error('no ipc'))
    await unqueueMessage('s1', 'steer', 0, 'drop me')
    const error = useChatStore.getState().sessions.s1?.error
    expect(error).toMatch(/needs pi/)
    expect(error).not.toMatch(/this machine has/)
  })

  it('does not blame the version when the installed pi already supports the drain', async () => {
    piCommand.mockResolvedValue({ success: false, error: 'not streaming' })
    installedPi('0.85.1')
    await unqueueMessage('s1', 'steer', 0, 'drop me')
    const error = useChatStore.getState().sessions.s1?.error
    expect(error).toMatch(/not streaming/)
    expect(error).not.toMatch(/needs pi/)
  })

  it('names the messages it could not put back', async () => {
    piCommand.mockImplementation((_id: string, command: RpcCommand) =>
      command.type === 'clear_queue'
        ? Promise.resolve({
            success: true,
            data: { steering: ['keep me', 'drop me'], followUp: [] },
          })
        : Promise.resolve({ success: false, error: 'not streaming' }),
    )
    await unqueueMessage('s1', 'steer', 1, 'drop me')
    expect(useChatStore.getState().sessions.s1?.error).toMatch(/keep me/)
  })
})
