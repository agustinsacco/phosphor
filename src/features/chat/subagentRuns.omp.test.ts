import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentMessage, PiEvent } from '@shared/rpc'
import {
  emptyChatSession,
  hydrateFromMessages,
  reduceChatEvent,
  reduceSubagentFrame,
  restoreSubagents,
  type ChatSessionState,
  type ToolState,
} from './reducer'
import { isToolActive, ompTaskView, summarizeTool } from './tools/toolSummaries'
import { ompFleet } from './subagentRuns'

/**
 * omp's `task`, folded the way a session view folds it: events through the
 * reducer, subagent frames through `reduceSubagentFrame`. The frames are the
 * recorded omp stdout scripts/omp-subagents.zsh also replays through the real
 * client (electron/pi/__fixtures__/omp-task-replay.json).
 */
const replay = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../electron/pi/__fixtures__/omp-task-replay.json',
    ),
    'utf8',
  ),
) as { turns: Array<Array<Record<string, unknown> & { type: string }>> }

const CALL = 'toolu_01TaskScouts'

function fold(
  frames: Array<Record<string, unknown> & { type: string }>,
  initial = emptyChatSession(),
): ChatSessionState {
  // PiRpcClient drops omp's updates to a call that already ended (`OmpEndedTools`).
  const ended = new Set<unknown>()
  let state = initial
  for (const frame of frames) {
    if (frame.type.startsWith('subagent_')) {
      state = reduceSubagentFrame(state, frame)
      continue
    }
    if (frame.type === 'tool_execution_update' && ended.has(frame.toolCallId)) continue
    if (frame.type === 'tool_execution_end') ended.add(frame.toolCallId)
    state = reduceChatEvent(state, frame as unknown as PiEvent)
  }
  return state
}

function children(tool: ToolState | undefined) {
  return tool ? (ompTaskView(tool)?.run.children ?? []) : []
}

describe('omp task rows', () => {
  it('shows one card per running subagent with its agent and current tool', () => {
    const state = fold(replay.turns[0]!)
    const tool = state.tools[CALL]!
    // The call returned at once (a background job); its agents still run.
    expect(tool.status).toBe('done')
    expect(isToolActive(tool)).toBe(true)
    expect(summarizeTool(tool)).toEqual({
      label: 'Delegating to',
      object: 'scout',
      hint: '0/2 done',
    })
    expect(
      children(tool).map(({ agent, label, status, currentTool, toolCount }) => ({
        agent,
        label,
        status,
        currentTool,
        toolCount,
      })),
    ).toEqual([
      {
        agent: 'scout',
        label: 'ListElectron',
        status: 'running',
        currentTool: 'read electron',
        toolCount: 1,
      },
      {
        agent: 'scout',
        label: 'ListSrc',
        status: 'running',
        currentTool: 'find src/*',
        toolCount: 1,
      },
    ])
    expect(ompFleet(Object.values(state.tools))?.runs.map((run) => [run.id, run.state])).toEqual([
      ['ListElectron', 'running'],
      ['ListSrc', 'running'],
    ])
  })

  it('detaches pending async snapshots without live frames after the parent settles', () => {
    const details = {
      projectAgentsDir: null,
      results: [],
      totalDurationMs: 1,
      progress: [{ id: 'Detached', index: 0, agent: 'scout', status: 'pending' }],
      async: { state: 'running', jobId: 'Detached', type: 'task' },
    }
    const state = run([
      {
        type: 'tool_execution_start',
        toolCallId: 'detached-task',
        toolName: 'task',
        args: { agent: 'scout', task: 'wait' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'detached-task',
        toolName: 'task',
        result: { content: [], details },
        isError: false,
      },
    ])
    const tool = state.tools['detached-task']!
    expect(children(tool)).toMatchObject([{ status: 'detached' }])
    expect(isToolActive(tool)).toBe(false)
  })

  it('settles each subagent with its answer, tools, tokens and time', () => {
    const state = fold(replay.turns.flat())
    const tool = state.tools[CALL]!
    expect(isToolActive(tool)).toBe(false)
    expect(summarizeTool(tool)).toEqual({
      label: 'Delegated to',
      object: 'scout',
      hint: '2 agents',
    })
    const [electron, src] = children(tool)
    expect(electron).toMatchObject({
      status: 'completed',
      currentTool: undefined,
      toolCount: 3,
      tokens: 8421,
      durationMs: 12400,
      turnCount: 3,
      model: 'anthropic/claude-haiku-4-5',
    })
    expect(electron!.output).toMatch(/^electron\/ holds the main process/)
    // omp keeps recent tools newest first; the card reads oldest to newest.
    expect(electron!.recentTools).toEqual(['read electron', 'read electron/pi', 'yield'])
    expect(src).toMatchObject({ status: 'completed', toolCount: 2, tokens: 6130, durationMs: 9800 })
    expect(ompFleet(Object.values(state.tools))).toBeNull()
  })

  it('restores still-running subagents from get_subagents on reopen', () => {
    // Reopened from disk: the session file holds the call and the snapshot omp
    // took when it returned, which says nothing about how the agents ended.
    const messages = replay.turns[0]!.filter((frame) => frame.type === 'message_end').map(
      (frame) => frame.message as AgentMessage,
    )
    const reopened = hydrateFromMessages(messages)
    expect(children(reopened.tools[CALL]).map((child) => child.status)).toEqual([
      'detached',
      'detached',
    ])

    const snapshot = (id: string, index: number, currentTool: string) => ({
      id,
      index,
      agent: 'scout',
      status: 'running',
      parentToolCallId: CALL,
      progress: { index, id, agent: 'scout', status: 'running', currentTool, toolCount: 2 },
    })
    const restored = restoreSubagents(reopened, [
      snapshot('ListElectron', 0, 'read'),
      snapshot('ListSrc', 1, 'find'),
    ])
    const tool = restored.tools[CALL]!
    expect(isToolActive(tool)).toBe(true)
    expect(children(tool).map(({ status, currentTool }) => [status, currentTool])).toEqual([
      ['running', 'read'],
      ['running', 'find'],
    ])
  })

  it('keeps a live frame over a later get_subagents snapshot', () => {
    const live = fold(replay.turns[0]!)
    const restored = restoreSubagents(live, [
      {
        id: 'ListElectron',
        index: 0,
        agent: 'scout',
        status: 'running',
        parentToolCallId: CALL,
        progress: { id: 'ListElectron', status: 'running', currentTool: 'stale' },
      },
    ])
    expect(restored).toBe(live)
  })

  it('ignores frames it cannot place or read', () => {
    const state = fold(replay.turns[0]!)
    for (const frame of [
      null,
      'subagent_progress',
      { type: 'subagent_progress' },
      { type: 'subagent_progress', payload: { parentToolCallId: CALL, progress: 'x' } },
      { type: 'subagent_lifecycle', payload: { id: 'Other', status: 'started' } },
      // A subagent's own nested call, or one this transcript does not hold.
      {
        type: 'subagent_lifecycle',
        payload: { id: 'Nested', agent: 'scout', status: 'started', parentToolCallId: 'elsewhere' },
      },
      { type: 'subagent_event', payload: { id: 'ListElectron', event: {} } },
    ]) {
      expect(reduceSubagentFrame(state, frame)).toBe(state)
    }
    expect(restoreSubagents(state, [null, 7, { id: 'x' }, { parentToolCallId: CALL }])).toBe(state)
  })

  it('leaves a task tool whose details are not omp’s on the generic row', () => {
    const state = run([
      {
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'task',
        args: { task: 'x' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'task',
        result: { content: [{ type: 'text', text: 'ok' }], details: { results: 'not a list' } },
        isError: false,
      },
    ])
    const tool = state.tools.t1!
    expect(ompTaskView(tool)).toBeNull()
    expect(summarizeTool(tool).label).not.toMatch(/Delegat/)
  })
})

function run(events: PiEvent[]): ChatSessionState {
  return events.reduce(reduceChatEvent, emptyChatSession())
}
