import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiEvent, RpcCommand, RpcResponse } from '@shared/rpc'
import {
  BRAIN_LANE_CLOSED,
  createBrainAgentLane,
  newestTranscript,
  type BrainLaneClient,
} from './agent-lane'
import { BRAIN_AGENT_RULES } from './lane-folder'

const MESSAGE = 'Defrag. 2 waiting: 1 read, 1 flag. Start with brain_waiting.'

/** A pi process as the Brain lane sees it: get_state answers, prompts start a turn. */
class FakeLane extends EventEmitter {
  alive = true
  file: string | undefined
  busy = false
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
        isCompacting: false,
        pendingMessageCount: 0,
        sessionFile: this.file,
      },
    } as unknown as RpcResponse
  })
  send(event: PiEvent) {
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
    transcripts: vi.fn(() => transcripts),
    create: vi.fn(async () => ({ sessionId: 'brain-1', workspacePath: folder })),
    client: vi.fn(() => lane as unknown as BrainLaneClient),
    command: vi.fn(async (_id: string, command: RpcCommand): Promise<RpcResponse> => {
      if (command.type === 'prompt') queueMicrotask(() => void onPrompt())
      return command.type === 'prompt'
        ? promptResponse
        : ({ type: 'response', command: command.type, success: true } as RpcResponse)
    }),
    changed: vi.fn(),
  }
  return { deps, agent: createBrainAgentLane(deps) }
}
const commands = (deps: ReturnType<typeof host>['deps']) =>
  deps.command.mock.calls.map(([, command]) => command.type)
const ended = () => lane.send({ type: 'agent_end', messages: [] } as unknown as PiEvent)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'brain-lane-'))
  folder = join(root, 'userData/brain/Brain')
  transcripts = join(root, 'sessions')
  lane = new FakeLane()
  onPrompt = ended
  promptResponse = { type: 'response', command: 'prompt', success: true } as RpcResponse
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('a Defrag turn in the Brain lane', () => {
  it('starts the lane as Brain Agent with the default rules, then sends the message', async () => {
    const { deps, agent } = host()
    const started = vi.fn()
    const turn = await agent.turn(MESSAGE, new AbortController().signal, started)
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
    expect(started).toHaveBeenCalledWith('/sessions/brain/new.jsonl')
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
    const turn = await agent.turn(MESSAGE, new AbortController().signal, vi.fn())
    expect(deps.create).toHaveBeenCalledWith(
      { workspacePath: folder, sessionPath: join(transcripts, 'newest.jsonl') },
      { keepLastWorkspace: true },
    )
    expect(turn).toMatchObject({ outcome: 'finished', rulesChanged: true })
    expect(await newestTranscript(join(root, 'missing'))).toBeNull()
  })

  it('waits for the owner’s turn to settle, and finishes on the end that will not retry', async () => {
    lane.busy = true
    onPrompt = () => {
      lane.send({ type: 'agent_end', messages: [], willRetry: true } as unknown as PiEvent)
      queueMicrotask(ended)
    }
    const { deps, agent } = host()
    const turn = agent.turn(MESSAGE, new AbortController().signal, vi.fn())
    await vi.waitFor(() => expect(lane.listenerCount('event')).toBe(1))
    expect(commands(deps)).toEqual([])
    lane.send({ type: 'agent_settled', aborted: false } as PiEvent)
    expect(await turn).toMatchObject({ outcome: 'finished', error: null })
  })

  it('stops its own turn with abort, and leaves a busy owner’s turn alone', async () => {
    onPrompt = () => {}
    const own = host()
    const controller = new AbortController()
    const turn = own.agent.turn(MESSAGE, controller.signal, vi.fn())
    await vi.waitFor(() => expect(commands(own.deps)).toEqual(['prompt']))
    controller.abort()
    expect(await turn).toMatchObject({ outcome: 'stopped', error: null })
    expect(commands(own.deps)).toEqual(['prompt', 'abort'])

    lane = new FakeLane()
    lane.busy = true
    const waiting = host()
    const stop = new AbortController()
    const queued = waiting.agent.turn(MESSAGE, stop.signal, vi.fn())
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
    expect(await host().agent.turn(MESSAGE, new AbortController().signal, vi.fn())).toMatchObject({
      outcome: 'failed',
      error: BRAIN_LANE_CLOSED,
    })
    lane = new FakeLane()
    onPrompt = () => lane.send({ type: 'extension_error', error: 'boom' } as unknown as PiEvent)
    expect(await host().agent.turn(MESSAGE, new AbortController().signal, vi.fn())).toMatchObject({
      outcome: 'failed',
      error: 'Extension error: boom',
    })
    lane = new FakeLane()
    onPrompt = () => {}
    promptResponse = { type: 'response', command: 'prompt', success: false, error: 'No model.' }
    expect(await host().agent.turn(MESSAGE, new AbortController().signal, vi.fn())).toMatchObject({
      outcome: 'failed',
      error: 'No model.',
    })
  })
})
