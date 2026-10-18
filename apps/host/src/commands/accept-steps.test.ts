import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, RpcSessionState } from '@phosphor/shared/rpc'
import * as lifecycle from '../session/lifecycle'
import { ACCEPT_TIMINGS, type AcceptContext } from './accept'
import { createAcceptLaneState, type AcceptLaneState } from './accept-lane'
import {
  abortStep,
  call,
  CleanupFailed,
  closeStep,
  promptStep,
  resumeStep,
  startStep,
  stateStep,
  stop,
} from './accept-steps'

let folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'accept-steps-'))
  vi.spyOn(lifecycle, 'isGone').mockReturnValue(true)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(folder, { recursive: true, force: true })
})

function setup() {
  const context: AcceptContext = {
    configPath: '/config',
    env: {},
    platform: 'linux',
    uid: 1000,
    home: '/home',
    hostname: 'host',
    nodeVersion: process.version,
    defaultResourceRoot: '/resources',
    repository: folder,
    lane: 'native',
    keepTranscripts: false,
    progress: vi.fn(),
  }
  const runtime = {
    start: vi.fn<AcceptLaneState['runtime']['start']>(),
    command: vi.fn<AcceptLaneState['runtime']['command']>(),
    stop: vi.fn<AcceptLaneState['runtime']['stop']>().mockResolvedValue(),
    remove: vi.fn<AcceptLaneState['runtime']['remove']>().mockResolvedValue(),
    life: lifecycle.createLifecycle(() => {}),
  }
  const state = createAcceptLaneState(runtime, 'native', context, {
    timings: ACCEPT_TIMINGS,
    settleMs: 0,
    progress: context.progress,
  })
  runtime.start.mockImplementation(async (_request, deliver) => {
    deliver?.({
      kind: 'extension-ui',
      request: {
        type: 'extension_ui_request',
        id: 'status',
        method: 'setStatus',
        statusKey: 'phosphor-context-breakdown',
        statusText: 'loaded',
      },
    })
    return { sessionId: 'session', workspacePath: folder, pid: 12345 }
  })
  state.session = { sessionId: 'session', pid: 12345 }
  return { state, runtime }
}

function rpcState(): RpcSessionState {
  return {
    model: {
      id: 'model',
      name: 'model',
      provider: 'native',
      api: 'test',
      reasoning: true,
      input: ['text'],
      contextWindow: 200000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    thinkingLevel: 'high',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'all',
    sessionFile: join(folder, 'session.jsonl'),
    sessionId: 'session',
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  }
}

const reply = (
  text: string,
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason })

function finish(state: AcceptLaneState, message: AssistantMessage): void {
  state.watch.deliver({ kind: 'event', event: { type: 'agent_end', messages: [message] } })
}

describe('accept steps', () => {
  it('accepts status delivered before start answers and verifies the bundled command', async () => {
    const { state, runtime } = setup()
    state.session = null
    runtime.command.mockResolvedValue({
      type: 'response',
      command: 'get_commands',
      success: true,
      data: { commands: [{ name: 'phosphor-context-budget', source: 'extension' }] },
    })
    await startStep(state)
    expect(state.session).toMatchObject({ sessionId: 'session', pid: 12345 })
    expect(state.result.extensionsLoaded).toBe(true)
    expect(runtime.start).toHaveBeenCalledWith({ repository: folder }, state.watch.deliver)
  })

  it('stores the actual provider, model, thinking and transcript while validating a qualified model', async () => {
    const { state, runtime } = setup()
    state.context.provider = 'native'
    state.context.model = 'native/model:high'
    runtime.command.mockResolvedValue({
      type: 'response',
      command: 'get_state',
      success: true,
      data: rpcState(),
    })
    await stateStep(state)
    expect(state.result).toMatchObject({
      provider: 'native',
      model: 'model',
      thinkingLevel: 'high',
      transcript: join(folder, 'session.jsonl'),
    })
    state.context.model = 'native/other:high'
    await expect(stateStep(state)).rejects.toThrow('the native lane runs model model, not other')
  })

  it('requires a transcript before any prompt runs', async () => {
    const { state, runtime } = setup()
    runtime.command.mockResolvedValue({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { ...rpcState(), sessionFile: undefined },
    })
    await expect(stateStep(state)).rejects.toThrow('pi names no session file')
  })

  it('prompts with its own token and finds an end delivered before the command answer', async () => {
    const { state, runtime } = setup()
    runtime.command.mockImplementation(async (_id, command) => {
      if (command.type === 'prompt') finish(state, reply(state.token))
      return { type: 'response', command: command.type, success: true, data: { text: state.token } }
    })
    await promptStep(state)
    expect(runtime.command).toHaveBeenNthCalledWith(1, 'session', {
      type: 'prompt',
      message: `Reply with exactly this token and nothing else: ${state.token}`,
    })
    expect(state.watch.count('agent_end')).toBe(1)
    state.session = null
    expect(() => call(state, { type: 'get_state' })).toThrow('no session is running')
  })

  it('preserves a failed turn diagnostic instead of asking for the last text', async () => {
    const { state, runtime } = setup()
    runtime.command.mockImplementation(async () => {
      finish(state, { ...reply('', 'error'), errorMessage: 'provider failed' })
      return { type: 'response', command: 'prompt', success: true }
    })
    await expect(promptStep(state)).rejects.toThrow('the turn failed: provider failed')
    expect(runtime.command).toHaveBeenCalledTimes(1)
  })

  it('charges the abort answer and agent_end against one deadline', async () => {
    vi.useFakeTimers()
    const { state, runtime } = setup()
    state.timings = { ...ACCEPT_TIMINGS, abortMs: 100 }
    runtime.command.mockImplementation(async (_id, command) => {
      if (command.type === 'prompt')
        state.watch.deliver({
          kind: 'event',
          event: {
            type: 'message_update',
            assistantMessageEvent: {
              type: 'text_delta',
              contentIndex: 0,
              delta: '1',
            },
          },
        })
      if (command.type === 'abort') await new Promise((resolve) => setTimeout(resolve, 80))
      return { type: 'response', command: command.type, success: true }
    })
    const pending = abortStep(state)
    const assertion = expect(pending).rejects.toThrow('no agent_end within 100 ms')
    await vi.advanceTimersByTimeAsync(99)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks that abort ended streaming after receiving agent_end', async () => {
    const { state, runtime } = setup()
    runtime.command.mockImplementation(async (_id, command) => {
      if (command.type === 'prompt')
        state.watch.deliver({
          kind: 'event',
          event: {
            type: 'message_update',
            assistantMessageEvent: {
              type: 'text_delta',
              contentIndex: 0,
              delta: '1',
            },
          },
        })
      if (command.type === 'abort') finish(state, reply('1', 'aborted'))
      return {
        type: 'response',
        command: command.type,
        success: true,
        data: { ...rpcState(), isStreaming: true },
      }
    })
    await expect(abortStep(state)).rejects.toThrow('pi is still streaming')
  })

  it.each(['token', 'aborted', 'neither'] as const)(
    'resumes the transcript and refuses a history missing %s evidence',
    async (missing) => {
      const { state, runtime } = setup()
      state.result.transcript = join(folder, 'session.jsonl')
      runtime.command.mockImplementation(async (_id, command) => ({
        type: 'response',
        command: command.type,
        success: true,
        data: {
          messages:
            missing === 'token'
              ? [reply('count', 'aborted')]
              : missing === 'aborted'
                ? [reply(state.token)]
                : [],
        },
      }))
      await expect(resumeStep(state)).rejects.toThrow(
        missing === 'aborted'
          ? 'get_messages lacks the aborted turn'
          : 'get_messages lacks the token reply',
      )
      expect(runtime.start).toHaveBeenCalledWith(
        { repository: folder, sessionPath: state.result.transcript },
        state.watch.deliver,
      )
    },
  )

  it('resumes and recalls only after finding both persisted replies', async () => {
    const { state, runtime } = setup()
    runtime.command.mockImplementation(async (_id, command) => {
      if (command.type === 'prompt') finish(state, reply(state.token))
      return {
        type: 'response',
        command: command.type,
        success: true,
        data:
          command.type === 'get_messages'
            ? { messages: [reply(state.token), reply('1', 'aborted')] }
            : { text: state.token },
      }
    })
    await resumeStep(state)
    expect(runtime.command.mock.calls.map(([, command]) => command.type)).toEqual([
      'get_messages',
      'prompt',
      'get_last_assistant_text',
    ])
  })

  it('clears ownership before checking a stopped process group and flags a surviving group', async () => {
    const { state, runtime } = setup()
    vi.mocked(lifecycle.isGone).mockReturnValue(false)
    await expect(stop(state)).rejects.toThrow('process group 12345 is still there')
    expect(state.session).toBeNull()
    expect(state.result.groupsAlive).toBe(1)
    expect(runtime.stop).toHaveBeenCalledExactlyOnceWith('session')
  })

  it('distinguishes a failed stop with no group left from cleanup failure', async () => {
    const { state, runtime } = setup()
    runtime.stop.mockRejectedValue(new Error('already exited'))
    const failure = stop(state)
    await expect(failure).rejects.toThrow('the stop failed: already exited')
    await expect(failure).rejects.not.toBeInstanceOf(CleanupFailed)
  })

  it.each([false, true])(
    'validates LF JSONL and deletes through runtime.remove unless keep=%s',
    async (keep) => {
      const { state, runtime } = setup()
      const file = join(folder, 'session.jsonl')
      writeFileSync(file, '{"text":"one\u2028two\u2029"}\n\n{}\n')
      state.result.transcript = file
      state.context.keepTranscripts = keep
      runtime.remove.mockImplementation(async () => {
        unlinkSync(file)
      })
      await closeStep(state)
      expect(state.session).toBeNull()
      expect(state.result.transcriptDeleted).toBe(!keep)
      expect(existsSync(file)).toBe(keep)
      if (keep) expect(runtime.remove).not.toHaveBeenCalled()
      else
        expect(runtime.remove).toHaveBeenCalledExactlyOnceWith({
          repository: folder,
          sessionPath: file,
        })
    },
  )

  it('retains invalid JSONL and reports its LF line number', async () => {
    const { state, runtime } = setup()
    const file = join(folder, 'bad.jsonl')
    writeFileSync(file, '{}\n\nnot json\n')
    state.result.transcript = file
    await expect(closeStep(state)).rejects.toThrow('the transcript is not JSONL at line 3')
    expect(runtime.remove).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(true)
  })

  it.each(['refused', 'still present'])(
    'treats deletion %s as cleanup failure',
    async (failure) => {
      const { state, runtime } = setup()
      const file = join(folder, 'session.jsonl')
      writeFileSync(file, '{}\n')
      state.result.transcript = file
      if (failure === 'refused') runtime.remove.mockRejectedValue(new Error('locked'))
      const pending = closeStep(state)
      await expect(pending).rejects.toBeInstanceOf(CleanupFailed)
      await expect(pending).rejects.toThrow(
        failure === 'refused' ? 'the deletion failed: locked' : 'the transcript is still there',
      )
      expect(state.result.transcriptDeleted).toBe(false)
      expect(existsSync(file)).toBe(true)
    },
  )
})
