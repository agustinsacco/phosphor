// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { stopSubagent } from './subagentStop'
import { hydrateFromMessages } from './reducer'

const piCommand = vi.fn()
const snapshot = (state = 'running') => ({
  'subagent-async': {
    placement: 'aboveEditor' as const,
    lines: [
      `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ kind: 'pi-subagents.async-status-snapshot', version: 1, runs: [{ id: 'run-a', state }] })}`,
    ],
  },
})
beforeEach(() => {
  // @ts-expect-error only these preload methods are used
  window.phosphor = { piCommand }
  useExtensionUiStore.setState({ widgets: { owner: snapshot() } })
  piCommand
    .mockReset()
    .mockImplementation(async (_sessionId, command) =>
      command.type === 'get_commands'
        ? { success: true, data: { commands: [{ name: 'subagents-stop', source: 'extension' }] } }
        : { success: true },
    )
})

describe('exact-run Stop', () => {
  it('uses the extension command and never marks a run stopped optimistically', async () => {
    await stopSubagent('owner', 'run-a')
    expect(piCommand).toHaveBeenLastCalledWith('owner', {
      type: 'prompt',
      message: '/subagents-stop run-a',
    })
    expect(useExtensionUiStore.getState().widgets.owner).toEqual(snapshot())
  })
  it('refuses another session, a partial id, a finished run and command injection', async () => {
    await expect(stopSubagent('other', 'run-a')).rejects.toThrow('no longer reported active')
    await expect(stopSubagent('owner', 'run')).rejects.toThrow('no longer reported active')
    await expect(stopSubagent('owner', 'run-a\nother')).rejects.toThrow('identity')
    useExtensionUiStore.setState({ widgets: { owner: snapshot('complete') } })
    await expect(stopSubagent('owner', 'run-a')).rejects.toThrow('no longer reported active')
    expect(piCommand.mock.calls.every(([, cmd]) => cmd.type === 'get_commands')).toBe(true)
  })
  it('does not turn a missing command or a same-name prompt template into a model turn', async () => {
    for (const commands of [[], [{ name: 'subagents-stop', source: 'prompt' }]]) {
      piCommand.mockResolvedValue({ success: true, data: { commands } })
      await expect(stopSubagent('owner', 'run-a')).rejects.toThrow('does not support')
    }
    expect(piCommand.mock.calls.every(([, cmd]) => cmd.type === 'get_commands')).toBe(true)
  })
  it('retains hidden native command receipts on reload', () => {
    const details = { requestId: 'receipt-a', result: { details: { runId: 'run-a' } } }
    expect(
      hydrateFromMessages([
        {
          role: 'custom',
          customType: 'subagent-slash-result',
          display: false,
          content: 'Stopped run-a',
          details,
        },
      ]).items[0],
    ).toMatchObject({ text: 'Stopped run-a', details, quiet: true })
  })
})
