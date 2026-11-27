import { describe, expect, it } from 'vitest'
import type { ToolState } from '@/features/chat/chatItems'
import type { WorkEntry } from '@/features/chat/currentWork'
import { laneAgents, laneDoing } from './laneWork'

const entry = (id: string, over: Partial<WorkEntry> = {}): WorkEntry => ({
  id,
  label: id,
  state: 'running',
  active: 1,
  attention: false,
  ...over,
})

describe('laneAgents', () => {
  it('counts running agents and keeps the ones finished this turn', () => {
    const view = laneAgents(
      [
        entry('reviewer', { currentTool: 'grep', title: 'Check IPC' }),
        entry('worker', { active: 0, state: 'finished', endedAt: 200, title: 'Fix lint' }),
        entry('old', { active: 0, state: 'finished', endedAt: 50 }),
        entry('broke', { active: 0, state: 'failed', endedAt: 300 }),
      ],
      100,
      {},
    )
    expect(view?.running).toBe(1)
    expect(view?.agents.map((a) => [a.label, a.detail, a.running, a.failed])).toEqual([
      ['reviewer', 'grep', true, false],
      ['worker', 'Fix lint', false, false],
      ['broke', undefined, false, true],
    ])
  })

  it('splits one parallel call into its children', () => {
    const tool = {
      toolCallId: 'p',
      toolName: 'subagent',
      status: 'running',
      args: { tasks: [{ agent: 'scout', task: 'Map callers' }, { agent: 'worker' }] },
      output: {
        content: [],
        details: {
          mode: 'parallel',
          progress: [
            { index: 0, agent: 'scout', status: 'completed' },
            { index: 1, agent: 'worker', status: 'running', currentTool: 'bash' },
          ],
        },
      },
    } as unknown as ToolState
    const view = laneAgents([entry('p', { toolCallId: 'p', active: 1 })], 100, { p: tool })
    expect(view?.running).toBe(1)
    expect(view?.agents.map((a) => [a.label, a.detail, a.running])).toEqual([
      ['scout', 'Map callers', false],
      ['worker', 'bash', true],
    ])
  })

  it('shows nothing once no agent is running', () => {
    expect(laneAgents([entry('worker', { active: 0, endedAt: 200 })], 100, {})).toBeNull()
    expect(laneAgents([], 100, {})).toBeNull()
  })
})

describe('laneDoing', () => {
  const tool = (id: string, over: Partial<ToolState>): ToolState =>
    ({ toolCallId: id, toolName: 'read', status: 'running', ...over }) as ToolState

  it("names the parent's newest running tool this turn", () => {
    const tools = {
      a: tool('a', { startedAt: 110, args: { path: '/r/a.ts' } }),
      b: tool('b', { startedAt: 120, args: { path: '/r/registry.ts' } }),
      c: tool('c', { startedAt: 130, status: 'done', args: { path: '/r/c.ts' } }),
    }
    expect(laneDoing(tools, 100)).toBe('Reading registry.ts')
  })

  it('ignores tools left running from an earlier turn', () => {
    expect(laneDoing({ a: tool('a', { startedAt: 50 }) }, 100)).toBeUndefined()
    expect(laneDoing({ a: tool('a', { startedAt: 50 }) }, null)).toBeUndefined()
  })
})
