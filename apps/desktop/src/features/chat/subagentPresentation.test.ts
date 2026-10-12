import { expect, it } from 'vitest'
import type { CustomItem, ToolState } from './chatItems'
import { newestWork, supervisorHandoff, taskPreview, workTime } from './subagentPresentation'

const tool: ToolState = {
  toolCallId: 't',
  toolName: 'subagent',
  argsText: '',
  args: { agent: 'worker', task: '# Fix auth\n\nKeep the boundary.' },
  status: 'done',
  startedAt: 1,
  endedAt: 2,
  output: { content: [{ type: 'text', text: 'Partial preview' }] },
  result: {
    content: [{ type: 'text', text: 'Final receipt' }],
    details: { runId: 'a', results: [] },
  },
}
const notice = (runs: string[]): CustomItem => ({
  id: 'n',
  kind: 'custom',
  customType: 'subagent-notify',
  inContext: true,
  timestamp: 3,
  text: 'Background task completed: **worker**\n\nActual response.',
  details: { runs: runs.map((runId) => ({ runId, status: 'completed' })) },
})
it('orders requests newest first and keeps missing timestamps explicit', () => {
  expect(newestWork([{ requestedAt: 2 }, { startedAt: 4 }, { endedAt: 1 }, {}])).toEqual([
    { startedAt: 4 },
    { requestedAt: 2 },
    { endedAt: 1 },
    {},
  ])
  expect(workTime()).toBe('Time not reported')
  expect(workTime(undefined, undefined, 1)).toMatch(/^Requested /)
  expect(taskPreview('## Fix auth\n\nDetails')).toBe('Fix auth Details')
})
it('uses the final parent tool receipt, never a stale streaming output', () => {
  expect(supervisorHandoff({ t: tool }, [], { runId: 'a' })).toEqual({
    kind: 'tool-result',
    input: '# Fix auth\n\nKeep the boundary.',
    output: 'Final receipt',
    receivedAt: 2,
  })
})
it('does not give a child its containing workflow prompt or result', () => {
  expect(supervisorHandoff({ t: tool }, [notice(['a'])], { runId: 'a', childId: '0' })).toEqual({})
  expect(supervisorHandoff({ t: tool }, [notice(['a'])], { runId: 'other' })).toEqual({})
})
it('shows a single native completion, not a same-named worker or mixed batch', () => {
  expect(supervisorHandoff({}, [notice(['a'])], { runId: 'a' })).toEqual({
    kind: 'notification',
    output: notice(['a']).text,
    receivedAt: 3,
  })
  expect(supervisorHandoff({}, [notice(['a', 'b'])], { runId: 'a' })).toEqual({})
  expect(supervisorHandoff({}, [notice(['b'])], { runId: 'a' })).toEqual({})
})
it('ignores management replies and out-of-context records as child handoffs', () => {
  expect(
    supervisorHandoff({ t: { ...tool, args: { action: 'status', id: 'a' } } }, [], { runId: 'a' }),
  ).toEqual({})
  expect(supervisorHandoff({}, [{ ...notice(['a']), inContext: false }], { runId: 'a' })).toEqual(
    {},
  )
  expect(
    supervisorHandoff({ t: { ...tool, args: { ...tool.args, async: true } } }, [], { runId: 'a' }),
  ).toEqual({ input: tool.args!.task })
})
it('never calls a detached launch receipt a final output', () => {
  const detached = {
    ...tool,
    result: { ...tool.result!, details: { background: true, runId: 'a' } },
  }
  expect(supervisorHandoff({ t: detached }, [], { runId: 'a' })).toEqual({ input: tool.args!.task })
})
