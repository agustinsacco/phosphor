import { expect, it } from 'vitest'
import type { CustomItem, ToolState } from './chatItems'
import {
  activityText,
  distinctTitles,
  elapsed,
  newestWork,
  shortenPaths,
  supervisorHandoff,
  taskPreview,
  workTime,
} from './subagentPresentation'

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

it('titles prompts by their first distinct sentence, with paths shortened for display', () => {
  const shared = 'You are a worker. Read the brief at /Users/me/repo/briefs/plan.md first.'
  expect(
    distinctTitles([
      `${shared}\nImplement \`desktop-first-class.md\`.`,
      `${shared}\nImplement remote.md.`,
      undefined,
      '## Map the parser',
    ]),
  ).toEqual([
    'Implement desktop-first-class.md.',
    'Implement remote.md.',
    undefined,
    'Map the parser',
  ])
  // Alone, a prompt is its opening sentence.
  expect(distinctTitles([shared])).toEqual(['You are a worker.'])
  // A retry is the same prompt, not a reason to fall back to the preamble;
  // a sentence shared by two of three prompts still beats the preamble.
  expect(
    distinctTitles([
      `${shared}\nFix A.`,
      `${shared}\nFix A.`,
      `${shared}\nFix B. Then report.`,
      `${shared}\nFix C. Then report.`,
    ]),
  ).toEqual(['Fix A.', 'Fix A.', 'Fix B.', 'Fix C.'])
  expect(distinctTitles(['x'.repeat(200)])[0]).toHaveLength(120)
  expect(shortenPaths('see /a/b/c.ts and ~/x/y/, not a/b or https://h.io/a/b')).toBe(
    'see c.ts and y, not a/b or https://h.io/a/b',
  )
})

it('says what a running agent is doing from reported facts only', () => {
  expect(elapsed(-5)).toBe('0s')
  expect(elapsed(12_900)).toBe('12s')
  expect(elapsed(425_000)).toBe('7m 05s')
  expect(elapsed(3_840_000)).toBe('1h 04m')
  const now = 100_000
  expect(activityText({ active: 1, currentTool: 'bash', currentToolStartedAt: 88_000 }, now)).toBe(
    'bash 12s',
  )
  expect(activityText({ active: 1, lastActivityAt: 95_000, toolCount: 1 }, now)).toBe(
    'working · 1 tool',
  )
  expect(activityText({ active: 1, lastActivityAt: 40_000, toolCount: 3 }, now)).toBe(
    'quiet 1m 00s · 3 tools',
  )
  expect(activityText({ active: 1 }, now)).toBe('working')
  // Finished work keeps its counters but never a current tool.
  expect(activityText({ active: 0, currentTool: 'bash', toolCount: 2 }, now)).toBe('2 tools')
})

it("treats a single run's step as the launch, and a parallel step as its own prompt", () => {
  expect(
    supervisorHandoff({ t: tool }, [], { runId: 'a', childId: 'step:0' }, { single: true }),
  ).toMatchObject({
    kind: 'tool-result',
    input: tool.args!.task,
    output: 'Final receipt',
  })
  const parallel: ToolState = {
    ...tool,
    args: {
      tasks: [
        { agent: 'scout', task: 'Map' },
        { agent: 'reviewer', task: 'Review' },
      ],
    },
  }
  expect(
    supervisorHandoff({ t: parallel }, [notice(['a'])], { runId: 'a', childId: 'step:1' }),
  ).toEqual({
    input: 'Review',
  })
  // Restored without a snapshot: a solo launch's step:0 is still the launch.
  expect(supervisorHandoff({ t: tool }, [], { runId: 'a', childId: 'step:0' })).toMatchObject({
    kind: 'tool-result',
    input: tool.args!.task,
  })
  // A workflow's prompt and entries are never a child's own.
  const workflow: ToolState = { ...tool, args: { workflow: 'review', tasks: parallel.args!.tasks } }
  expect(supervisorHandoff({ t: workflow }, [], { runId: 'a', childId: 'step:1' })).toEqual({})
})
