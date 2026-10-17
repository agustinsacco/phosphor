import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitInfo } from '@phosphor/session-runtime/git/git-info'
import { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import {
  isRoutineSession,
  routineSessionForPath,
} from '@phosphor/session-runtime/routines/ownership'
import { newRoutine, type RoutineRun } from '@phosphor/shared/routines'
import type { AssistantMessage, PiEvent, RpcSessionState } from '@phosphor/shared/rpc'
import { createLifecycle } from '../session/lifecycle'
import type { Delivery, HostRuntime } from '../session/runtime'
import { createRoutineExecutor } from './runner'

vi.mock('@phosphor/session-runtime/git/git-info', () => ({ gitInfo: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

const root = realpathSync.native(tmpdir())
const sessionId = 'routine-session'
const sessionPath = `${root}/routine-session.jsonl`
const message: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Created a report.' }],
  stopReason: 'stop',
}
const finished = {
  status: 'finished',
  summary: 'Created a report.',
  reason: 'Agent turn finished. Outcome and external deliveries are unverified; review the lane.',
}
const warned = {
  ...finished,
  reason:
    'Turn finished with tool errors. Outcome and external deliveries are unverified; inspect the lane.',
}
const state: RpcSessionState = {
  model: {
    id: 'test-model',
    name: 'Test',
    api: 'test',
    provider: 'test',
    reasoning: false,
    input: ['text'],
    contextWindow: 200000,
    maxTokens: 8000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'one-at-a-time',
  followUpMode: 'one-at-a-time',
  sessionFile: sessionPath,
  sessionId,
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
}
function run(): RoutineRun {
  return {
    id: 'run',
    routineId: 'routine',
    trigger: 'manual',
    scheduledAt: 0,
    createdAt: 0,
    startedAt: 0,
    endedAt: null,
    status: 'running',
    reason: '',
    definition: {
      ...newRoutine(root),
      id: 'routine',
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
      nextAt: null,
      attention: null,
      archived: false,
      instructions: 'Report.',
      provider: 'test',
      model: 'test-model',
      isolated: false,
      intent: 'report',
    },
    sessionId: null,
    sessionPath: null,
    workspacePath: null,
    branch: null,
    baseCommit: null,
    accountId: null,
    summary: '',
  }
}
async function start() {
  vi.mocked(gitInfo).mockResolvedValue({ isRepo: false, branch: '', dirtyCount: 0 })
  let push: Delivery = () => {
    throw new Error('delivery not attached')
  }
  let prompted: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    prompted = resolve
  })
  const client = new PiRpcClient({ cwd: root }, { log: vi.fn(), isClosing: () => false })
  vi.spyOn(client, 'alive', 'get').mockReturnValue(true)
  const request = vi.spyOn(client, 'request').mockImplementation(async (command) => {
    if (command.type === 'prompt') prompted()
    return {
      type: 'response',
      command: command.type,
      success: true,
      data: command.type === 'get_state' ? state : undefined,
    }
  })
  const runtime = {
    replaceRoots: vi.fn<HostRuntime['replaceRoots']>(),
    life: createLifecycle(vi.fn()),
    drain: vi.fn<HostRuntime['drain']>(),
    start: vi.fn<HostRuntime['start']>(),
    command: vi.fn<HostRuntime['command']>(),
    extensionUiResponse: vi.fn<HostRuntime['extensionUiResponse']>(),
    stop: vi.fn<HostRuntime['stop']>(),
    remove: vi.fn<HostRuntime['remove']>(),
    list: vi.fn<HostRuntime['list']>().mockReturnValue([]),
    startRoutine: vi.fn<HostRuntime['startRoutine']>().mockImplementation(async (_, deliver) => {
      push = deliver
      return { sessionId, workspacePath: root }
    }),
    routineClient: vi.fn<HostRuntime['routineClient']>().mockReturnValue(client),
    stopRoutine: vi.fn<HostRuntime['stopRoutine']>().mockImplementation(async () => {
      expect(isRoutineSession(sessionId)).toBe(true)
    }),
  } satisfies HostRuntime
  const admittedRoot = vi.fn((path: string) => path)
  const progress = vi.fn()
  const controller = new AbortController()
  const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
  const completed = createRoutineExecutor(runtime, admittedRoot)(run(), controller.signal, progress)
  await ready
  return {
    completed,
    controller,
    removeListener,
    runtime,
    request,
    admittedRoot,
    progress,
    event: (event: PiEvent) => push({ kind: 'event', event }),
  }
}
function toolEnd(isError: boolean, parentToolCallId?: string): PiEvent {
  return {
    type: 'tool_execution_end',
    toolCallId: parentToolCallId ? 'child' : 'parent',
    toolName: parentToolCallId ? 'bash' : 'codemode',
    result: { content: [{ type: 'text', text: isError ? 'Failed' : 'Done' }] },
    isError,
    ...(parentToolCallId ? { parentToolCallId } : {}),
  }
}

describe('Host routine runner characterization', () => {
  it('finishes written output, disables retries before prompting, and releases ownership after stop', async () => {
    const test = await start()
    expect(test.admittedRoot).toHaveBeenCalledWith(root)
    expect(test.runtime.startRoutine).toHaveBeenCalledWith(
      { repository: root, provider: 'test', model: 'test-model' },
      expect.any(Function),
      { intent: 'report', signal: test.controller.signal },
    )
    expect(test.request.mock.calls.map(([command]) => command.type)).toEqual([
      'get_state',
      'set_auto_retry',
      'prompt',
    ])
    expect(test.request.mock.calls[1]?.[0]).toEqual({ type: 'set_auto_retry', enabled: false })
    expect(routineSessionForPath(sessionPath)).toBe(sessionId)
    test.event({ type: 'agent_end', messages: [message] })
    await expect(test.completed).resolves.toEqual(finished)
    expect(test.progress).toHaveBeenCalledWith({ workspacePath: root })
    expect(test.progress).toHaveBeenCalledWith({ sessionId })
    expect(
      test.progress.mock.calls.filter(([patch]) => patch.sessionPath === sessionPath),
    ).toHaveLength(2)
    expect(test.runtime.stopRoutine).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(isRoutineSession(sessionId)).toBe(false)
    expect(routineSessionForPath(sessionPath)).toBeUndefined()
    expect(test.removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('warns about a top-level tool error even with successful text', async () => {
    const test = await start()
    test.event(toolEnd(true))
    test.event({ type: 'agent_end', messages: [message] })
    await expect(test.completed).resolves.toEqual(warned)
  })

  it.each([
    { messages: [], reason: 'No assistant result was received.' },
    {
      messages: [{ ...message, content: [] }],
      reason:
        'The agent returned no written outcome. Inspect the lane before repeating any actions.',
    },
  ])('fails missing written output: $reason', async ({ messages, reason }) => {
    const test = await start()
    test.event({ type: 'agent_end', messages })
    await expect(test.completed).resolves.toEqual({ status: 'failed', reason })
    expect(test.runtime.stopRoutine).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(isRoutineSession(sessionId)).toBe(false)
  })

  it('fails an extension error and ignores later success', async () => {
    const test = await start()
    test.event({ type: 'extension_error', error: 'Extension exploded' })
    test.event({ type: 'agent_end', messages: [message] })
    await expect(test.completed).resolves.toEqual({
      status: 'failed',
      reason: 'An extension failed.',
    })
    expect(test.runtime.stopRoutine).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(isRoutineSession(sessionId)).toBe(false)
  })

  it('waits through a retry tail and uses the final assistant when agent_end has no messages', async () => {
    const test = await start()
    test.event({ type: 'agent_end', messages: [], willRetry: true })
    await Promise.resolve()
    expect(test.runtime.stopRoutine).not.toHaveBeenCalled()
    test.event({ type: 'message_end', message })
    test.event({ type: 'agent_end', messages: [] })
    await expect(test.completed).resolves.toEqual(finished)
  })

  it('cancels, skips the final state read, and stops before releasing ownership', async () => {
    const test = await start()
    test.controller.abort()
    test.event({ type: 'agent_end', messages: [message] })
    await expect(test.completed).resolves.toEqual({
      status: 'cancelled',
      reason: 'Stopped. External effects may already have completed.',
    })
    expect(test.request.mock.calls.map(([command]) => command.type)).toEqual([
      'get_state',
      'set_auto_retry',
      'prompt',
    ])
    expect(test.runtime.stopRoutine).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(isRoutineSession(sessionId)).toBe(false)
    expect(test.removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

describe('Host routine runner nested-tool outcomes', () => {
  it('finishes without a tool warning when the parent handles a nested failure', async () => {
    const test = await start()
    test.event(toolEnd(true, 'parent'))
    test.event(toolEnd(false))
    test.event({ type: 'agent_end', messages: [message] })
    await expect(test.completed).resolves.toEqual(finished)
  })

  it('warns when the parent fails after a nested failure', async () => {
    const test = await start()
    test.event(toolEnd(true, 'parent'))
    test.event(toolEnd(true))
    test.event({ type: 'agent_end', messages: [message] })
    await expect(test.completed).resolves.toEqual(warned)
  })

  it('does not clear an earlier top-level error when a later parent handles its child', async () => {
    const test = await start()
    test.event(toolEnd(true))
    test.event(toolEnd(true, 'parent'))
    test.event(toolEnd(false))
    test.event({ type: 'agent_end', messages: [message] })
    await expect(test.completed).resolves.toEqual(warned)
  })

  it.each([
    { patch: { errorMessage: 'Provider failed' }, reason: 'Provider failed' },
    { patch: { stopReason: 'error' as const }, reason: 'Agent stopped: error.' },
    { patch: { stopReason: 'aborted' as const }, reason: 'Agent stopped: aborted.' },
  ])(
    'cannot hide assistant failure after a handled child error: $reason',
    async ({ patch, reason }) => {
      const test = await start()
      test.event(toolEnd(true, 'parent'))
      test.event(toolEnd(false))
      test.event({ type: 'agent_end', messages: [{ ...message, ...patch }] })
      await expect(test.completed).resolves.toEqual({ status: 'failed', reason })
    },
  )
})
