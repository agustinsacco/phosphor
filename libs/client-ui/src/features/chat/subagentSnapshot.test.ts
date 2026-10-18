// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  SNAPSHOT_COMMAND,
  SNAPSHOT_PREFIX,
  SNAPSHOT_WIDGET,
  snapshotContent,
  type InspectionSnapshot,
} from '@phosphor/pi-extensions/subagent-snapshot'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useArtifactsStore } from '@/stores/artifacts'
import { useLayoutStore } from '@/stores/layout'
import { saveSubagentSnapshot } from './subagentSnapshot'
const snapshot: InspectionSnapshot = {
  sourceSessionId: 'native',
  runId: 'run',
  readAt: '2026-10-11T10:00:00Z',
  inspection: { messages: [{ role: 'assistant', text: 'Result' }], truncated: true },
}
const piCommand = vi.fn()
function publish(sessionId: string, reply?: object): void {
  useExtensionUiStore.getState().handleRequest(sessionId, {
    type: 'extension_ui_request',
    id: 'reply',
    method: 'setWidget',
    widgetKey: SNAPSHOT_WIDGET,
    widgetLines: reply ? [`${SNAPSHOT_PREFIX}${JSON.stringify(reply)}`] : undefined,
  })
}
beforeEach(() => {
  useExtensionUiStore.setState({ widgets: {} })
  useArtifactsStore.setState({ bySession: {}, selected: {}, unseen: {} })
  useLayoutStore.setState({ bySession: {} })
  // @ts-expect-error partial preload
  window.phosphor = { piCommand }
  piCommand.mockReset().mockImplementation(async (_id, c) => {
    if (c.type === 'get_commands')
      return {
        success: true,
        data: { commands: [{ name: SNAPSHOT_COMMAND, source: 'extension' }] },
      }
    const [, requestId, payload] = c.message.split(' ')
    expect(JSON.parse(decodeURIComponent(payload))).toEqual(snapshot)
    publish('lane', {
      requestId,
      artifact: {
        id: 'subagent-snapshot-test',
        title: 'Saved subagent snapshot',
        type: 'markdown',
        version: 1,
        content: snapshotContent(snapshot, 'native'),
      },
    })
    publish('lane')
    return { success: true }
  })
})
afterEach(() => vi.useRealTimers())
it('catches an immediate save receipt and adds the durable snapshot without taking the pane', async () => {
  await expect(saveSubagentSnapshot('lane', snapshot, new AbortController().signal)).resolves.toBe(
    'subagent-snapshot-test',
  )
  expect(
    useArtifactsStore.getState().bySession.lane?.['subagent-snapshot-test']?.versions[0]?.content,
  ).toContain('Result')
  expect(useLayoutStore.getState().bySession.lane).toBeUndefined()
})
it('does not invoke a missing or same-name prompt command', async () => {
  piCommand.mockResolvedValue({
    success: true,
    data: { commands: [{ name: SNAPSHOT_COMMAND, source: 'prompt' }] },
  })
  await expect(
    saveSubagentSnapshot('lane', snapshot, new AbortController().signal),
  ).rejects.toThrow('does not support')
  expect(piCommand).toHaveBeenCalledTimes(1)
})
it('cancels pending saves and does not consume another lane’s receipt', async () => {
  vi.useFakeTimers()
  piCommand.mockImplementation(async (_id, c) => {
    if (c.type === 'get_commands')
      return {
        success: true,
        data: { commands: [{ name: SNAPSHOT_COMMAND, source: 'extension' }] },
      }
    publish('foreign', { requestId: c.message.split(' ')[1], error: 'Foreign failure' })
    return { success: true }
  })
  const abort = new AbortController()
  const result = expect(saveSubagentSnapshot('lane', snapshot, abort.signal)).rejects.toThrow(
    'cancelled',
  )
  await Promise.resolve()
  abort.abort()
  await result
  expect(useArtifactsStore.getState().bySession.lane).toBeUndefined()
})
