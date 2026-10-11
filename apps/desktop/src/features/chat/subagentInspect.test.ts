// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { inspectSubagent } from './subagentInspect'

const piCommand = vi.fn()
const controller = () => new AbortController()
const request = (signal = controller().signal) =>
  inspectSubagent('lane-a', 'run-a', 'child-a', signal)
const publish = (sessionId: string, data?: object) =>
  useExtensionUiStore.getState().handleRequest(sessionId, {
    type: 'extension_ui_request',
    id: 'event',
    method: 'setWidget',
    widgetKey: 'subagent-inspect',
    widgetLines: data ? [`PI_SUBAGENT_INSPECT_JSON:${JSON.stringify(data)}`] : undefined,
  })

beforeEach(() => {
  useExtensionUiStore.setState({ widgets: {} })
  piCommand.mockReset()
  // @ts-expect-error only this preload method is used
  window.phosphor = { piCommand }
  piCommand.mockImplementation(async (_id, command) => {
    if (command.type === 'get_commands')
      return {
        success: true,
        data: { commands: [{ name: 'subagents-inspect-rpc', source: 'extension' }] },
      }
    const requestId = command.message.split(' ')[1]
    publish('lane-a', {
      kind: 'pi-subagents.inspect-reply',
      version: 1,
      requestId,
      asyncId: 'run-a',
      childId: 'child-a',
      messages: [{ role: 'assistant', text: 'Checked the parser.' }],
      truncated: { messages: 2 },
    })
    publish('lane-a')
    return { success: true }
  })
})
afterEach(() => vi.useRealTimers())

describe('read-only subagent inspection', () => {
  it('catches an emit-then-retract reply without reading a file or prompting a model', async () => {
    await expect(request()).resolves.toMatchObject({
      messages: [{ text: 'Checked the parser.' }],
      truncated: true,
    })
    expect(piCommand.mock.calls[1]?.[1].message).toMatch(
      /^\/subagents-inspect-rpc [\w-]+ run-a child-a --lines 100$/,
    )
    expect(useExtensionUiStore.getState().widgets['lane-a']?.['subagent-inspect']).toBeUndefined()
  })

  it('does not send a slash prompt when the command is absent', async () => {
    piCommand.mockResolvedValue({ success: true, data: { commands: [] } })
    await expect(request()).rejects.toThrow('does not support')
    expect(piCommand).toHaveBeenCalledTimes(1)
  })

  it.each(['run with spaces', '--lines', '', 'a'.repeat(257)])(
    'rejects invalid identity %s',
    async (id) => {
      await expect(inspectSubagent('lane-a', id, undefined, controller().signal)).rejects.toThrow(
        'identity',
      )
      expect(piCommand).not.toHaveBeenCalled()
    },
  )

  it('ignores other sessions and uncorrelated replies and times out', async () => {
    vi.useFakeTimers()
    piCommand.mockImplementation(async (_id, command) => {
      if (command.type === 'get_commands')
        return {
          success: true,
          data: { commands: [{ name: 'subagents-inspect-rpc', source: 'extension' }] },
        }
      const reply = {
        kind: 'pi-subagents.inspect-reply',
        version: 1,
        requestId: command.message.split(' ')[1],
        asyncId: 'run-a',
        childId: 'child-a',
      }
      publish('lane-b', reply)
      publish('lane-a', { ...reply, requestId: 'old-request' })
      return { success: true }
    })
    const result = expect(request()).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10_001)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    [{ asyncId: 'different-run' }, 'did not match'],
    [{ childId: 'different-child' }, 'did not match'],
    [{ version: 2 }, 'version'],
    [{ error: { code: 'foreign_session', message: 'Not owned by this session' } }, 'Not owned'],
  ])('fails closed on a correlated but unusable reply %j', async (override, error) => {
    piCommand.mockImplementationOnce(async () => ({
      success: true,
      data: { commands: [{ name: 'subagents-inspect-rpc', source: 'extension' }] },
    }))
    piCommand.mockImplementationOnce(async (_id, command) => {
      publish('lane-a', {
        kind: 'pi-subagents.inspect-reply',
        version: 1,
        requestId: command.message.split(' ')[1],
        asyncId: 'run-a',
        childId: 'child-a',
        ...override,
      })
      return { success: true }
    })
    await expect(request()).rejects.toThrow(error)
    expect(piCommand).toHaveBeenCalledTimes(2)
  })

  it('cancels outstanding subscriptions when the panel closes', async () => {
    vi.useFakeTimers()
    piCommand.mockResolvedValue({
      success: true,
      data: { commands: [{ name: 'subagents-inspect-rpc', source: 'extension' }] },
    })
    const abort = controller()
    const result = expect(request(abort.signal)).rejects.toThrow('cancelled')
    await Promise.resolve()
    abort.abort()
    await result
    expect(vi.getTimerCount()).toBe(0)
  })
})
