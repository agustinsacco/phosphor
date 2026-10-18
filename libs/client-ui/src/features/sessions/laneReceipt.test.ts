import { collectTouchedFiles } from '@/features/files/collectTouchedFiles'
import { receiptFacts } from '@shared/lane-receipt'
import { expect, it } from 'vitest'
import type { ChatItem, ToolState } from '@/features/chat/chatItems'
import { laneReceipt, machineColour } from './laneReceipt'
it('counts only tools in the settled run and preserves error excerpts and timing', () => {
  const items: ChatItem[] = [
    {
      id: 'old',
      kind: 'assistant',
      streaming: false,
      blocks: [{ type: 'tool', index: 0, toolCallId: 'old' }],
    },
    { id: 'u', kind: 'user', text: 'task' },
    {
      id: 'a',
      kind: 'assistant',
      streaming: false,
      blocks: [{ type: 'tool', index: 0, toolCallId: 'new' }],
      stopReason: 'error',
      errorMessage: 'Stopped **here**',
    },
  ]
  const tool: ToolState = {
    toolCallId: 'new',
    toolName: 'write',
    args: { path: 'a', content: 'a\nb' },
    argsText: '',
    status: 'done',
    output: null,
    result: { content: [] },
  }
  expect(
    laneReceipt({
      items,
      tools: {
        new: tool,
        old: { ...tool, toolCallId: 'old', args: { path: 'b', content: 'old' } },
      },
      title: 'Lane',
      repository: 'repo',
      branch: 'main',
      startedAt: 10,
      settledAt: 30,
    }),
  ).toMatchObject({
    files: 1,
    added: 2,
    removed: 0,
    durationMs: 20,
    outcome: 'error',
    excerpt: 'Stopped here',
  })
})
it('assigns fixed local and stable deterministic machine colours', () => {
  expect(machineColour()).toBe('#729568')
  expect(machineColour('bee1')).toBe(machineColour('bee1'))
  expect(machineColour('bee1')).not.toBe(machineColour())
})

it('matches the Changes pane for display diffs, unified patches and repeated writes', () => {
  const tools: Record<string, ToolState> = {}
  const cases = [
    { name: 'edit', args: { path: '/repo/a' }, details: { diff: '- 18 old\n+ 18 new' } },
    { name: 'edit', args: { path: 'a' }, details: { patch: '--- a\n+++ a\n-old\n+new\n+extra' } },
    { name: 'write', args: { path: 'b', content: 'one\ntwo' }, details: {} },
    { name: 'write', args: { path: 'b', content: 'three' }, details: {} },
  ]
  cases.forEach((entry, i) => {
    tools[String(i)] = {
      toolCallId: String(i),
      toolName: entry.name,
      args: entry.args,
      argsText: '',
      status: 'done',
      output: null,
      result: { content: [], details: entry.details },
    }
  })
  const changed = collectTouchedFiles(tools, '/repo')
  expect(
    receiptFacts(
      cases.map((entry) => ({
        name: entry.name,
        args: entry.args,
        details: entry.details,
        done: true,
      })),
      '/repo',
    ),
  ).toMatchObject({
    files: changed.length,
    added: changed.reduce((n, file) => n + file.additions, 0),
    removed: changed.reduce((n, file) => n + file.deletions, 0),
  })
})

it('includes queued prompts in the same measured run rather than only the final prompt', () => {
  const items: ChatItem[] = [
    { id: 'u1', kind: 'user', text: 'first', timestamp: 10 },
    {
      id: 'a1',
      kind: 'assistant',
      streaming: false,
      blocks: [{ type: 'tool', index: 0, toolCallId: 'edit' }],
    },
    { id: 'u2', kind: 'user', text: 'queued', timestamp: 30 },
    {
      id: 'a2',
      kind: 'assistant',
      streaming: false,
      blocks: [{ type: 'text', text: 'Done', index: 0, closed: true }],
    },
  ]
  const tool: ToolState = {
    toolCallId: 'edit',
    toolName: 'write',
    args: { path: 'a', content: 'one' },
    argsText: '',
    status: 'done',
    output: null,
    result: { content: [] },
  }
  expect(
    laneReceipt({
      items,
      tools: { edit: tool },
      title: 'Lane',
      repository: 'repo',
      branch: 'main',
      startedAt: 20,
      settledAt: 50,
    }),
  ).toMatchObject({ files: 1, added: 1, durationMs: 30, excerpt: 'Done' })
})
