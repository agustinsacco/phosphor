// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { steerSubagent } from './subagentSteer'

const piCommand = vi.fn()
const target = { runId: 'root', childId: 'step' }
function fleet(state = 'running'): void {
  useExtensionUiStore.setState({
    widgets: {
      lane: {
        'subagent-async': {
          placement: 'aboveEditor',
          lines: [
            `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ kind: 'pi-subagents.async-status-snapshot', version: 1, runs: [{ id: 'root', state, children: [{ id: 'step', state }] }] })}`,
          ],
        },
      },
    },
  })
}
beforeEach(() => {
  // @ts-expect-error partial preload
  window.phosphor = { piCommand }
  piCommand
    .mockReset()
    .mockImplementation(async (_id, command) =>
      command.type === 'get_commands'
        ? { success: true, data: { commands: [{ name: 'subagents-steer', source: 'extension' }] } }
        : { success: true },
    )
  fleet()
})
it('addresses the exact owned child with whitespace normalization and no model-generated fallback', async () => {
  await steerSubagent('lane', target, ' Check\n the parser. ')
  expect(piCommand.mock.calls[1]).toEqual([
    'lane',
    { type: 'prompt', message: '/subagents-steer root --child step Check the parser.' },
  ])
})
it.each(['prompt', 'skill'])('refuses a same-name %s command', async (source) => {
  piCommand.mockResolvedValue({
    success: true,
    data: { commands: [{ name: 'subagents-steer', source }] },
  })
  await expect(steerSubagent('lane', target, 'Hello')).rejects.toThrow('does not support')
  expect(piCommand).toHaveBeenCalledTimes(1)
})
it('rechecks activity after capability discovery and refuses other lanes/targets', async () => {
  piCommand.mockImplementationOnce(async () => {
    fleet('complete')
    return { success: true, data: { commands: [{ name: 'subagents-steer', source: 'extension' }] } }
  })
  await expect(steerSubagent('lane', target, 'Hello')).rejects.toThrow('no longer')
  fleet()
  await expect(steerSubagent('other', target, 'Hello')).rejects.toThrow('no longer')
  await expect(steerSubagent('lane', { runId: 'root', childId: 'other' }, 'Hello')).rejects.toThrow(
    'no longer',
  )
  expect(piCommand.mock.calls.every(([, c]) => c.type === 'get_commands')).toBe(true)
})
it('rejects flag injection, invalid IDs, blank or oversized messages', async () => {
  for (const message of ['--child other redirect', '', 'x'.repeat(8001)])
    await expect(steerSubagent('lane', { runId: 'root' }, message)).rejects.toThrow()
  await expect(steerSubagent('lane', { runId: 'root other' }, 'Hello')).rejects.toThrow('identity')
  expect(piCommand).not.toHaveBeenCalled()
})
