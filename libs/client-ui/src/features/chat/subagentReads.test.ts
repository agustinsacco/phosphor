// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { inspectionSender, readSubagentEntries } from './subagentReads'

const piCommand = vi.fn()
const invoke = vi.fn()
const HOST_LANE = mockRemoteInfo.sessionId
const request = { requestId: 'request-1', runId: 'run-1', childId: 'step:0' }
const commands = (source: string) => ({
  success: true,
  data: { commands: [{ name: 'subagents-inspect-rpc', source }] },
})

beforeEach(() => {
  // @ts-expect-error only these preload methods are used
  window.phosphor = { piCommand, invoke }
  useSessionsStore.setState({
    live: {
      local: { phosphorId: 'local', workspacePath: '/repo' },
      [HOST_LANE]: { ...mockRemoteInfo, phosphorId: HOST_LANE },
    },
  })
})
afterEach(() => {
  piCommand.mockReset()
  invoke.mockReset()
})

describe('on This Mac, the reads ask pi', () => {
  it('reads the entries, and reports why it could not', async () => {
    piCommand.mockResolvedValueOnce({ success: true, data: { entries: [1], leafId: 'a' } })
    await expect(readSubagentEntries('local')).resolves.toEqual({ entries: [1], leafId: 'a' })
    expect(piCommand).toHaveBeenCalledWith('local', { type: 'get_entries' })
    piCommand.mockResolvedValueOnce({ success: false, error: 'pi is busy' })
    await expect(readSubagentEntries('local')).rejects.toThrow('pi is busy')
    piCommand.mockResolvedValueOnce({ success: true })
    await expect(readSubagentEntries('local')).rejects.toThrow('Recorded history is unavailable.')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('sends the inspect command only once pi lists it as an extension command', async () => {
    piCommand.mockResolvedValueOnce(commands('extension')).mockResolvedValueOnce({ success: true })
    await (
      await inspectionSender('local')
    )(request)
    expect(piCommand.mock.calls).toEqual([
      ['local', { type: 'get_commands' }],
      [
        'local',
        { type: 'prompt', message: '/subagents-inspect-rpc request-1 run-1 step:0 --lines 100' },
      ],
    ])
    piCommand.mockResolvedValueOnce(commands('prompt'))
    await expect(inspectionSender('local')).rejects.toThrow('does not support')
    piCommand.mockResolvedValueOnce(commands('extension'))
    piCommand.mockResolvedValueOnce({ success: false, error: 'busy' })
    await expect((await inspectionSender('local'))(request)).rejects.toThrow('busy')
  })
})

describe("on a Host lane, the reads are its Host's calls", () => {
  it('reads the entries through the window handle, never pi', async () => {
    invoke.mockResolvedValueOnce({ entries: [], leafId: null })
    await expect(readSubagentEntries(HOST_LANE)).resolves.toEqual({ entries: [], leafId: null })
    expect(invoke).toHaveBeenCalledWith('hosts:subagentHistory', HOST_LANE)
    invoke.mockRejectedValueOnce(new Error('Resume the lane to read its subagent history.'))
    await expect(readSubagentEntries(HOST_LANE)).rejects.toThrow('Resume the lane')
    expect(piCommand).not.toHaveBeenCalled()
  })

  it('inspects without a prompt op, which would take control of the lane', async () => {
    invoke.mockResolvedValueOnce(null)
    await (
      await inspectionSender(HOST_LANE)
    )(request)
    expect(invoke).toHaveBeenCalledWith('hosts:subagentInspect', HOST_LANE, request)
    invoke.mockRejectedValueOnce(new Error('This Host cannot inspect subagents.'))
    await expect((await inspectionSender(HOST_LANE))(request)).rejects.toThrow('cannot inspect')
    expect(piCommand).not.toHaveBeenCalled()
  })
})
