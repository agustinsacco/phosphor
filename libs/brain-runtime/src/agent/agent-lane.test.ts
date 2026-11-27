import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PiEvent, RpcCommand, RpcResponse } from '@phosphor/shared/rpc'
import {
  BRAIN_LANE_CLOSED,
  createBrainAgentLane,
  newestTranscript,
  type BrainLaneClient,
} from './agent-lane'
import { BRAIN_AGENT_RULES } from './rules'

const MESSAGE = 'Defrag. 2 waiting: 1 group, 1 flag. Start with brain_waiting.'

/**
 * A pi process as the Brain lane sees it: get_state answers, prompts start a turn, a turn's
 * settlement and a compaction's end leave it idle, and each response is reported as pi prints it.
 */
class FakeLane extends EventEmitter {
  alive = true
  file: string | undefined
  busy = false
  compacting = false
  /** Messages queued behind a turn; pi's abort leaves them queued. */
  pending = 0
  get sessionFile() {
    return this.file
  }
  request = vi.fn(async (command: RpcCommand): Promise<RpcResponse> => {
    if (command.type !== 'get_state') throw new Error(`unexpected ${command.type}`)
    this.file ??= '/sessions/brain/new.jsonl'
    return {
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        isStreaming: this.busy,
        isCompacting: this.compacting,
        pendingMessageCount: this.pending,
        sessionFile: this.file,
      },
    } as unknown as RpcResponse
  })
  send(event: PiEvent) {
    if (event.type === 'agent_settled') this.busy = false
    if (event.type === 'compaction_end') this.compacting = false
    this.emit('event', event)
  }
}

let root: string
let folder: string
let transcripts: string
let lane: FakeLane
let onPrompt: () => void | Promise<void>
let promptResponse: RpcResponse

function host() {
  const deps = {
    folder,
    resume: vi.fn(() => newestTranscript(transcripts)),
    create: vi.fn(async () => ({ sessionId: 'brain-1', workspacePath: folder })),
    client: vi.fn(() => lane as unknown as BrainLaneClient),
    command: vi.fn(async (_id: string, command: RpcCommand): Promise<RpcResponse> => {
      if (command.type === 'prompt') {
        lane.emit('response', promptResponse)
        queueMicrotask(() => void onPrompt())
      }
      return command.type === 'prompt'
        ? promptResponse
        : ({ type: 'response', command: command.type, success: true } as RpcResponse)
    }),
    changed: vi.fn(),
  }
  return { deps, agent: createBrainAgentLane(deps) }
}
const turnHooks = () => ({ opened: vi.fn(), sending: vi.fn() })
const commands = (deps: ReturnType<typeof host>['deps']) =>
  deps.command.mock.calls.map(([, command]) => command.type)
/** The run ends with Brain Agent's summary, as pi reports a turn that ended normally. */
const SUMMARY = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Decided 2 things.' }],
  stopReason: 'stop',
}
const endWith = (...messages: object[]) =>
  lane.send({ type: 'agent_end', messages } as unknown as PiEvent)
const ended = () => endWith({ role: 'user', content: MESSAGE }, SUMMARY)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'brain-lane-'))
  folder = join(root, 'userData/brain/Brain')
  transcripts = join(root, 'sessions')
  lane = new FakeLane()
  onPrompt = ended
  promptResponse = { id: 'px-1', type: 'response', command: 'prompt', success: true } as RpcResponse
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('a Defrag turn in the Brain lane', () => {
  it('starts the lane as Brain Agent with the default rules, then sends the message', async () => {
    const { deps, agent } = host()
    const hooks = turnHooks()
    const turn = await agent.turn(MESSAGE, new AbortController().signal, hooks)
    expect(turn).toEqual({
      outcome: 'finished',
      error: null,
      sessionPath: '/sessions/brain/new.jsonl',
      rulesChanged: false,
    })
    // Defrag never moves the folder Phosphor reopens at launch.
    expect(deps.create).toHaveBeenCalledWith(
      { workspacePath: folder, name: 'Brain Agent' },
      { keepLastWorkspace: true },
    )
    expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toBe(BRAIN_AGENT_RULES)
    expect(hooks.opened).toHaveBeenCalledWith('/sessions/brain/new.jsonl')
    // The transcript is known before the message goes, so opening the lane finds this process.
    expect(lane.request.mock.invocationCallOrder[0]).toBeLessThan(
      deps.command.mock.invocationCallOrder[0]!,
    )
    expect(deps.command).toHaveBeenCalledWith('brain-1', { type: 'prompt', message: MESSAGE })
    expect(deps.changed).toHaveBeenCalledWith(folder)
  })

  it('resumes the newest transcript, keeps the owner’s rules and reports their edit', async () => {
    await mkdir(transcripts, { recursive: true })
    for (const [name, at] of [
      ['old.jsonl', 1000],
      ['newest.jsonl', 3000],
      ['notes.txt', 5000],
    ] as const) {
      await writeFile(join(transcripts, name), '{}\n')
      await utimes(join(transcripts, name), at, at)
    }
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'AGENTS.md'), '# Mine')
    lane.file = join(transcripts, 'newest.jsonl')
    onPrompt = async () => {
      await writeFile(join(folder, 'AGENTS.md'), '# Mine, shorter')
      ended()
    }
    const { deps, agent } = host()
    const turn = await agent.turn(MESSAGE, new AbortController().signal, turnHooks())
    expect(deps.create).toHaveBeenCalledWith(
      { workspacePath: folder, sessionPath: join(transcripts, 'newest.jsonl') },
      { keepLastWorkspace: true },
    )
    expect(turn).toMatchObject({ outcome: 'finished', rulesChanged: true })
    expect(await newestTranscript(join(root, 'missing'))).toBeNull()
  })

  it('resumes the transcript its owner names and binds the one pi reports before sending', async () => {
    lane.file = '/sessions/brain/bound.jsonl'
    const { deps } = host()
    const bind = vi.fn(async () => {})
    const agent = createBrainAgentLane({
      ...deps,
      resume: async () => '/sessions/brain/bound.jsonl',
      bind,
    })
    await agent.turn(MESSAGE, new AbortController().signal, turnHooks())
    expect(deps.create).toHaveBeenCalledWith(
      { workspacePath: folder, sessionPath: '/sessions/brain/bound.jsonl' },
      { keepLastWorkspace: true },
    )
    expect(bind).toHaveBeenCalledWith('/sessions/brain/bound.jsonl')
    expect(bind.mock.invocationCallOrder[0]).toBeLessThan(deps.command.mock.invocationCallOrder[0]!)
  })

  it('waits for the owner’s turn to settle, and finishes on the end that will not retry', async () => {
    lane.busy = true
    onPrompt = () => {
      lane.send({ type: 'agent_end', messages: [], willRetry: true } as unknown as PiEvent)
      queueMicrotask(ended)
    }
    const { deps, agent } = host()
    const turn = agent.turn(MESSAGE, new AbortController().signal, turnHooks())
    await vi.waitFor(() => expect(lane.listenerCount('event')).toBe(1))
    expect(commands(deps)).toEqual([])
    lane.send({ type: 'agent_settled', aborted: false } as PiEvent)
    expect(await turn).toMatchObject({ outcome: 'finished', error: null })
  })

  it('says it is sending once the owner’s turn settles and pi accepts the message', async () => {
    lane.busy = true
    const ownerSettled = vi.fn()
    const answer = lane.request.getMockImplementation()!
    lane.request.mockImplementation(async (command) => {
      const response = await answer(command)
      // The second get_state is the wait for the owner's turn, which ends a moment later.
      if (lane.request.mock.calls.length === 2)
        setTimeout(() => {
          ownerSettled()
          lane.send({ type: 'agent_settled', aborted: false } as PiEvent)
        })
      return response
    })
    const { deps, agent } = host()
    const hooks = turnHooks()
    const turn = await agent.turn(MESSAGE, new AbortController().signal, hooks)
    expect(turn.outcome).toBe('finished')
    expect(hooks.sending).toHaveBeenCalledOnce()
    const [settledAt] = ownerSettled.mock.invocationCallOrder
    const [sendingAt] = hooks.sending.mock.invocationCallOrder
    const [promptAt] = deps.command.mock.invocationCallOrder
    expect(settledAt).toBeLessThan(promptAt!)
    expect(promptAt).toBeLessThan(sendingAt!)
  })

  it('leaves the turn to an owner’s message that reaches pi first, then sends again', async () => {
    const { deps, agent } = host()
    const hooks = turnHooks()
    // The owner's message passed its preflight as Defrag found the lane idle: pi starts their
    // turn and refuses Defrag's message, as it refuses any plain prompt while a turn runs.
    deps.command.mockImplementationOnce(async () => {
      lane.busy = true
      lane.send({ type: 'agent_start' } as PiEvent)
      setTimeout(() => {
        lane.busy = false
        endWith({ role: 'user', content: 'Is the Harbor read approved?' }, SUMMARY)
        lane.send({ type: 'agent_settled', aborted: false } as PiEvent)
      }, 20)
      return { type: 'response', command: 'prompt', success: false, error: 'Agent is busy.' }
    })
    const turn = await agent.turn(MESSAGE, new AbortController().signal, hooks)
    expect(turn).toMatchObject({ outcome: 'finished', error: null })
    expect(commands(deps)).toEqual(['prompt', 'prompt'])
    // Brain Agent answers Defrag only in the turn pi started for its message.
    expect(hooks.sending).toHaveBeenCalledOnce()
    expect(deps.command.mock.invocationCallOrder[1]).toBeLessThan(
      hooks.sending.mock.invocationCallOrder[0]!,
    )
  })

  it('sends once the lane is idle, however your turn or a compaction ended', async () => {
    // pi prints the busy state and your turn's settlement in one read: the client emits the
    // settlement before the state's waiter runs.
    lane.busy = true
    const answer = lane.request.getMockImplementation()!
    lane.request.mockImplementation(async (command) => {
      const response = await answer(command)
      if (lane.busy && lane.request.mock.calls.length === 2)
        lane.send({ type: 'agent_settled', aborted: false } as PiEvent)
      return response
    })
    const first = host()
    const stop = new AbortController()
    onTestFinished(() => stop.abort())
    const turn = first.agent.turn(MESSAGE, stop.signal, turnHooks())
    await vi.waitFor(() => expect(commands(first.deps)).toEqual(['prompt']))
    expect(await turn).toMatchObject({ outcome: 'finished' })

    // A compaction you started ends without a turn to settle.
    lane = new FakeLane()
    lane.compacting = true
    const second = host()
    const compacted = second.agent.turn(MESSAGE, stop.signal, turnHooks())
    await vi.waitFor(() => expect(lane.request).toHaveBeenCalledTimes(2))
    expect(commands(second.deps)).toEqual([])
    lane.send({ type: 'compaction_end', reason: 'manual', result: null, aborted: false })
    await vi.waitFor(() => expect(commands(second.deps)).toEqual(['prompt']))
    expect(await compacted).toMatchObject({ outcome: 'finished' })
  })

  it('never takes the end of a turn that finished before pi accepted its message', async () => {
    const { deps, agent } = host()
    const hooks = turnHooks()
    // Your turn fails while Defrag's message is in its preflight; pi prints that end, then
    // accepts Defrag's message and starts its turn.
    deps.command.mockImplementationOnce(async () => {
      endWith(
        { role: 'user', content: 'Is the Harbor read approved?' },
        { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Overloaded.' },
      )
      lane.send({ type: 'agent_settled', aborted: false } as PiEvent)
      lane.emit('response', promptResponse)
      queueMicrotask(() => void onPrompt())
      return promptResponse
    })
    const turn = await agent.turn(MESSAGE, new AbortController().signal, hooks)
    expect(turn).toMatchObject({ outcome: 'finished', error: null })
    expect(hooks.sending).toHaveBeenCalledOnce()
  })

  it('sends once you stop your turn, even with messages left queued behind it', async () => {
    lane.busy = true
    lane.pending = 1
    const { deps, agent } = host()
    const stop = new AbortController()
    onTestFinished(() => stop.abort())
    const turn = agent.turn(MESSAGE, stop.signal, turnHooks())
    await vi.waitFor(() => expect(lane.request).toHaveBeenCalledTimes(2))
    // pi's abort settles the lane and keeps the queue; no turn will deliver it.
    lane.send({ type: 'agent_settled', aborted: true } as PiEvent)
    await vi.waitFor(() => expect(commands(deps)).toEqual(['prompt']))
    expect(await turn).toMatchObject({ outcome: 'finished' })
  })

  it('keeps its own end when another prompt is answered right after it', async () => {
    const { deps, agent } = host()
    const stop = new AbortController()
    onTestFinished(() => stop.abort())
    // One read holds Defrag's response, its turn's end, then a context-file toggle's response.
    deps.command.mockImplementationOnce(async () => {
      lane.emit('response', promptResponse)
      ended()
      lane.emit('response', {
        id: 'px-2',
        type: 'response',
        command: 'prompt',
        success: true,
        data: { disposition: 'handled' },
      })
      return promptResponse
    })
    const turn = agent.turn(MESSAGE, stop.signal, turnHooks())
    const waited = new Promise((resolve) => setTimeout(() => resolve('still waiting'), 300))
    expect(await Promise.race([turn, waited])).toMatchObject({ outcome: 'finished' })
  })

  it('never fails on another command’s error, before or during its turn', async () => {
    const commandError = {
      type: 'extension_error',
      extensionPath: 'command:phosphor-context-files',
      event: 'command',
      error: 'Could not save the context-file choice.',
    } as PiEvent
    const { deps, agent } = host()
    // One read holds Defrag's response, a context-file toggle's error, then the toggle's response.
    deps.command.mockImplementationOnce(async () => {
      lane.emit('response', promptResponse)
      lane.send(commandError)
      lane.emit('response', { id: 'px-2', type: 'response', command: 'prompt', success: true })
      // The toggle fails again while Defrag's turn runs, before that turn ends.
      setTimeout(() => {
        lane.send(commandError)
        ended()
      })
      return promptResponse
    })
    const turn = await agent.turn(MESSAGE, new AbortController().signal, turnHooks())
    expect(turn).toMatchObject({ outcome: 'finished', error: null })
  })

  it('never aborts a turn pi has not started for it, and withdraws one pi starts after Stop', async () => {
    for (const accepted of [false, true]) {
      lane = new FakeLane()
      const { deps, agent } = host()
      let answer!: (response: RpcResponse) => void
      // The message waits behind the owner's, which pi may be about to start.
      deps.command.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      const stop = new AbortController()
      const turn = agent.turn(MESSAGE, stop.signal, turnHooks())
      await vi.waitFor(() => expect(commands(deps)).toEqual(['prompt']))
      stop.abort()
      expect(await turn).toMatchObject({ outcome: 'stopped', error: null })
      expect(commands(deps)).toEqual(['prompt'])
      answer(
        accepted
          ? ({ type: 'response', command: 'prompt', success: true } as RpcResponse)
          : { type: 'response', command: 'prompt', success: false, error: 'Agent is busy.' },
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(commands(deps)).toEqual(accepted ? ['prompt', 'abort'] : ['prompt'])
    }
  })

  it('stops its own turn with abort, and leaves a busy owner’s turn alone', async () => {
    onPrompt = () => {}
    const own = host()
    const controller = new AbortController()
    const turn = own.agent.turn(MESSAGE, controller.signal, turnHooks())
    await vi.waitFor(() => expect(commands(own.deps)).toEqual(['prompt']))
    controller.abort()
    expect(await turn).toMatchObject({ outcome: 'stopped', error: null })
    expect(commands(own.deps)).toEqual(['prompt', 'abort'])

    lane = new FakeLane()
    lane.busy = true
    const waiting = host()
    const stop = new AbortController()
    const queued = waiting.agent.turn(MESSAGE, stop.signal, turnHooks())
    await vi.waitFor(() => expect(lane.listenerCount('event')).toBe(1))
    stop.abort()
    expect(await queued).toMatchObject({ outcome: 'stopped', error: null })
    expect(commands(waiting.deps)).toEqual([])
  })

  it('fails when the lane exits, an extension errors or pi refuses the message', async () => {
    onPrompt = () => {
      lane.alive = false
      lane.emit('exit', { code: 1, signal: null, expected: false })
    }
    expect(
      await host().agent.turn(MESSAGE, new AbortController().signal, turnHooks()),
    ).toMatchObject({
      outcome: 'failed',
      error: BRAIN_LANE_CLOSED,
    })
    lane = new FakeLane()
    onPrompt = () => lane.send({ type: 'extension_error', error: 'boom' } as unknown as PiEvent)
    expect(
      await host().agent.turn(MESSAGE, new AbortController().signal, turnHooks()),
    ).toMatchObject({
      outcome: 'failed',
      error: 'Extension error: boom',
    })
    lane = new FakeLane()
    onPrompt = () => {}
    promptResponse = { type: 'response', command: 'prompt', success: false, error: 'No model.' }
    expect(
      await host().agent.turn(MESSAGE, new AbortController().signal, turnHooks()),
    ).toMatchObject({
      outcome: 'failed',
      error: 'No model.',
    })
  })

  it('fails on a provider error, stops on an abort, and fails when no answer came', async () => {
    const turnEndingWith = async (...messages: object[]) => {
      lane = new FakeLane()
      onPrompt = () => endWith({ role: 'user', content: MESSAGE }, ...messages)
      return host().agent.turn(MESSAGE, new AbortController().signal, turnHooks())
    }
    const failure = 'Provider overloaded (529).\nRetry later.'
    expect(
      await turnEndingWith(SUMMARY, {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: failure,
      }),
    ).toMatchObject({ outcome: 'failed', error: failure })
    expect(
      await turnEndingWith({ role: 'assistant', content: [], stopReason: 'aborted' }),
    ).toMatchObject({ outcome: 'stopped', error: null })
    expect(await turnEndingWith()).toMatchObject({ outcome: 'failed', error: null })
  })
})

it('sends tell as an ordinary owner prompt once the lane settles, returning at acceptance', async () => {
  const { agent, deps } = host()
  lane.busy = true
  onPrompt = () => {
    lane.busy = true
  }
  const result = agent.tell('Tom Lee leads Ledger.')
  await vi.waitFor(() => expect(lane.listenerCount('event')).toBe(1))
  expect(commands(deps)).toEqual([])
  lane.send({ type: 'agent_settled', aborted: false } as PiEvent)
  await expect(result).resolves.toEqual({ sessionPath: '/sessions/brain/new.jsonl' })
  expect(deps.command).toHaveBeenCalledWith('brain-1', {
    type: 'prompt',
    message: 'Tom Lee leads Ledger.',
  })
})
