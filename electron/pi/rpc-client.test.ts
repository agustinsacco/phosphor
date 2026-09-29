import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PiRpcClient } from './rpc-client'
import { shutdownApproval } from '../shutdown-approval'
import type { PiEvent } from '@shared/rpc'

const here = dirname(fileURLToPath(import.meta.url))
const fakePi = join(here, '__fixtures__', 'fake-pi.cjs')
const ompReplay = join(here, '__fixtures__', 'omp-task-replay.json')
const piReplay = join(here, '__fixtures__', 'pi-subagent-replay.json')

/** Resolves with the first event of `type` the client emits. */
function nextEvent(client: PiRpcClient, type: PiEvent['type']): Promise<PiEvent> {
  return new Promise((resolve) => {
    const listener = (event: PiEvent): void => {
      if (event.type !== type) return
      client.off('event', listener)
      resolve(event)
    }
    client.on('event', listener)
  })
}

function makeClient(): PiRpcClient {
  return new PiRpcClient({
    cwd: here,
    binaryPath: process.execPath,
    prefixArgs: [fakePi],
  })
}

let clients: PiRpcClient[] = []
const track = (c: PiRpcClient): PiRpcClient => {
  clients.push(c)
  return c
}

afterEach(async () => {
  await Promise.allSettled(clients.map((c) => c.dispose()))
  clients = []
})

describe('PiRpcClient', () => {
  it('rejects new work during approved shutdown but permits inspection and abort', async () => {
    const client = track(makeClient())
    client.spawn()
    const closing = vi.spyOn(shutdownApproval, 'closing', 'get').mockReturnValue(true)
    try {
      await expect(client.request({ type: 'prompt', message: 'not sent' })).rejects.toThrow(
        'shutting down',
      )
      expect((await client.request({ type: 'get_state' })).success).toBe(true)
      expect((await client.request({ type: 'abort' })).success).toBe(true)
      expect(client.activity.busy).toBe(false)
    } finally {
      closing.mockRestore()
    }
  })

  it('correlates request and response by id', async () => {
    const client = track(makeClient())
    client.spawn()
    const response = await client.request({ type: 'get_state' })
    expect(response.success).toBe(true)
    expect(client.sessionFile).toBe('/fake/session.jsonl')
    if (response.success) {
      expect(response.data?.sessionId).toBe('fake-session')
    }
  })

  it('tracks work before transport writes and before event consumers run', async () => {
    const client = track(makeClient())
    client.spawn()
    expect(client.activity.busy).toBe(true)
    await client.request({ type: 'get_state' })
    expect(client.activity.busy).toBe(false)
    const ended = new Promise<void>((resolve) => {
      client.on('event', (event) => {
        if (event.type === 'agent_end') {
          expect(client.activity.busy).toBe(true)
          resolve()
        }
      })
    })
    const prompt = client.request({ type: 'prompt', message: 'hi' })
    expect(client.activity.busy).toBe(true)
    await prompt
    await ended
    await client.request({ type: 'get_state' }) // This fixture predates agent_settled.
    expect(client.activity.busy).toBe(false)
    await client.dispose()
    expect(client.activity.busy).toBe(false)
  })

  it('resolves out-of-order responses to the right waiters', async () => {
    const client = track(makeClient())
    client.spawn()
    // fake-pi holds the compact response until abort arrives, then answers
    // abort first — both promises must still resolve correctly.
    const compactPromise = client.request({ type: 'compact' })
    await new Promise((r) => setTimeout(r, 30))
    const abortResponse = await client.request({ type: 'abort' })
    const compactResponse = await compactPromise
    expect(abortResponse.command).toBe('abort')
    expect(compactResponse.command).toBe('compact')
    if (compactResponse.success) {
      expect((compactResponse.data as { summary: string }).summary).toBe('S')
    }
  })

  it('resolves success:false responses (protocol errors are data)', async () => {
    const client = track(makeClient())
    client.spawn()
    const response = await client.request({ type: 'set_model', provider: 'x', modelId: 'nope' })
    expect(response.success).toBe(false)
    if (!response.success) {
      expect(response.error).toContain('nope')
    }
  })

  it('streams events (including records chunked mid-write)', async () => {
    const client = track(makeClient())
    client.spawn()
    const events: PiEvent[] = []
    const done = new Promise<void>((resolve) => {
      client.on('event', (event) => {
        events.push(event)
        if (event.type === 'agent_end') resolve()
      })
    })
    const response = await client.request({ type: 'prompt', message: 'hi' })
    expect(response.success).toBe(true)
    await done

    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'agent_start',
      'message_start',
      'message_update',
      'message_end',
      'agent_end',
    ])
    const update = events.find((e) => e.type === 'message_update')
    expect(update && 'assistantMessageEvent' in update).toBe(true)
    if (
      update &&
      update.type === 'message_update' &&
      update.assistantMessageEvent.type === 'text_delta'
    ) {
      expect(update.assistantMessageEvent.delta).toBe('Hello world')
    }
  })

  it('detects unexpected exit (crash) and rejects pending requests', async () => {
    const client = track(makeClient())
    client.spawn()
    const exitPromise = new Promise<{ expected: boolean; code: number | null }>((resolve) => {
      client.on('exit', ({ code, expected }) => resolve({ code, expected }))
    })
    // The fake exits with code 3 on this command without responding.
    const pending = client.request({ type: 'bash', command: 'CRASH' })
    const exit = await exitPromise
    expect(exit.expected).toBe(false)
    expect(exit.code).toBe(3)
    await expect(pending).rejects.toThrow(/exited/)
    expect(client.alive).toBe(false)
  })

  it('dispose() shuts down cleanly and marks exit as expected', async () => {
    const client = track(makeClient())
    client.spawn()
    await client.request({ type: 'get_state' })
    const exitPromise = new Promise<boolean>((resolve) => {
      client.on('exit', ({ expected }) => resolve(expected))
    })
    await client.dispose()
    expect(await exitPromise).toBe(true)
    expect(client.alive).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'disposes an owned process group including a stubborn nested provider',
    async () => {
      const client = track(
        new PiRpcClient({
          cwd: here,
          binaryPath: process.execPath,
          prefixArgs: [join(here, '__fixtures__', 'group-pi.cjs')],
          ownProcessGroup: true,
        }),
      )
      client.spawn()
      const response = await client.request({ type: 'get_state' })
      if (!response.success) throw new Error(response.error)
      const childPid = Number(response.data?.sessionId)
      expect(childPid).toBeGreaterThan(1)
      await client.dispose()
      await vi.waitFor(() => {
        let state = ''
        try {
          state = execFileSync('ps', ['-o', 'stat=', '-p', String(childPid)], {
            encoding: 'utf8',
          }).trim()
        } catch {
          /* process absent */
        }
        // Linux containers can retain a zombie until PID 1 reaps it; it is no
        // longer executing and is not a surviving provider.
        expect(state === '' || state.startsWith('Z')).toBe(true)
      })
    },
  )

  it('can dispose a failed spawn without waiting for an exit event that never comes', async () => {
    const client = track(new PiRpcClient({ cwd: here, binaryPath: '/missing-phosphor-pi' }))
    client.spawn()
    await client.dispose()
    expect(client.alive).toBe(false)
  })

  it('rejects requests when the process is not running', async () => {
    const client = track(makeClient())
    client.spawn()
    await client.dispose()
    await expect(client.request({ type: 'get_state' })).rejects.toThrow(/not running/)
  })

  it('rejects a write to a live child whose stdin closed, without an uncaught error', async () => {
    // The child stays alive but closes its read end, then says so on stderr,
    // so the next write fails (EPIPE/EIO) on a stream nobody else listens to.
    const client = track(
      new PiRpcClient({
        cwd: here,
        binaryPath: process.execPath,
        prefixArgs: [
          '-e',
          "process.stdin.destroy(); process.stderr.write('closed\\n'); setInterval(() => {}, 1e8)",
        ],
      }),
    )
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown): void => void uncaught.push(error)
    process.on('uncaughtException', onUncaught)
    try {
      const closed = once(client, 'stderr')
      client.spawn()
      await closed
      await expect(client.request({ type: 'get_state' })).rejects.toThrow()
      // The stream's 'error' follows the failed write callback on nextTick;
      // one event-loop turn delivers it before the assertion.
      await setImmediate()
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })

  it('never asks pi about subagents', async () => {
    const client = track(
      new PiRpcClient({
        cwd: here,
        binaryPath: process.execPath,
        prefixArgs: [fakePi],
        env: { FAKE_PI_REPLAY: piReplay },
      }),
    )
    const frames: unknown[] = []
    client.on('subagent', (frame) => frames.push(frame))
    client.spawn()
    const settled = nextEvent(client, 'agent_settled')
    await client.request({ type: 'prompt', message: 'review' })
    await settled
    expect(await client.getSubagents()).toEqual([])
    const state = await client.request({ type: 'get_state' })
    const data = state.success ? (state.data as unknown as Record<string, unknown>) : {}
    expect(data.received).toEqual(['prompt', 'get_state'])
    expect(client.subagentSubscription).toBeUndefined()
    expect(frames).toEqual([])
  })
})

describe('PiRpcClient speaking omp', () => {
  const fakeOmp = join(here, '__fixtures__', 'fake-omp.cjs')
  const makeOmp = (env: Record<string, string> = {}): PiRpcClient =>
    track(
      new PiRpcClient({
        cwd: here,
        agent: 'omp',
        binaryPath: process.execPath,
        prefixArgs: [fakeOmp],
        env,
      }),
    )

  it('consumes the ready frame instead of forwarding it as an event', async () => {
    const client = makeOmp()
    const events: PiEvent[] = []
    client.on('event', (event) => events.push(event))
    const ready = new Promise((resolve) => client.once('ready', resolve))
    client.spawn()
    expect(await ready).toMatchObject({ type: 'ready', protocolVersion: 1 })
    expect(client.readyFrame?.protocolVersion).toBe(1)
    await client.request({ type: 'get_state' })
    // Neither the handshake nor omp's command push reach event readers.
    expect(events).toEqual([])
  })

  it('answers get_commands from omp get_available_commands', async () => {
    const client = makeOmp()
    client.spawn()
    const response = await client.request({ type: 'get_commands' })
    expect(response.success).toBe(true)
    expect(response.command).toBe('get_commands')
    const names = response.success ? response.data?.commands.map((c) => c.name) : []
    expect(names).toEqual(['compact', 'c', 'skill:save'])
  })

  it('maps get_state queue counts and rewinds through branch', async () => {
    const client = makeOmp()
    const events: PiEvent[] = []
    client.on('event', (event) => events.push(event))
    client.spawn()
    const state = await client.request({ type: 'get_state' })
    expect(state.success && state.data?.pendingMessageCount).toBe(1)
    const fork = await client.request({ type: 'fork', entryId: 'e1' })
    expect(fork).toMatchObject({ command: 'fork', success: true, data: { text: 'rewound' } })
    expect(events).toEqual([{ type: 'agent_settled' }])
  })

  it('negotiates v2 before any command reaches omp, even one sent before ready', async () => {
    const client = makeOmp()
    client.spawn()
    // Issued at once: before the ready frame, let alone the 150 ms negotiation.
    const state = await client.request({ type: 'get_state' })
    expect(client.protocolVersion).toBe(2)
    const data = state.success ? (state.data as unknown as Record<string, unknown>) : {}
    // The subagent subscription rides with the handshake, ahead of the queue.
    expect(data.received).toEqual(['negotiate_protocol', 'set_subagent_subscription', 'get_state'])
    expect(data.sentBeforeNegotiation).toEqual([])
  })

  it('returns a history too big for one line whole, reassembled from chunks', async () => {
    const client = makeOmp()
    client.spawn()
    const response = await client.request({ type: 'get_messages' })
    expect(response.success).toBe(true)
    const message = response.success ? response.data?.messages[0] : undefined
    expect(message).toMatchObject({ role: 'user' })
    expect((message as { content: string }).content).toBe('é'.repeat(900 * 1024))
  })

  it('stays on v1 when v2 is not offered or is refused', async () => {
    const envs: Record<string, string>[] = [{ FAKE_OMP_NO_V2: '1' }, { FAKE_OMP_REFUSE_V2: '1' }]
    for (const env of envs) {
      const client = makeOmp(env)
      client.spawn()
      expect((await client.request({ type: 'get_state' })).success).toBe(true)
      expect(client.protocolVersion).toBe(1)
      // v1's own answer to an oversized frame, passed on unchanged.
      expect(await client.request({ type: 'get_messages' })).toMatchObject({
        success: false,
        error: 'RPC response exceeded the transport limit',
      })
    }
  })

  it('fails the waiting request with the reason when a chunk run breaks', async () => {
    for (const fault of ['interleave', 'skip', 'length']) {
      const client = makeOmp({ FAKE_OMP_CHUNK_FAULT: fault })
      const parseErrors: Error[] = []
      client.on('parse-error', ({ error }) => parseErrors.push(error))
      client.spawn()
      await expect(client.request({ type: 'get_messages' })).rejects.toThrow(
        /malformed chunked frame/,
      )
      expect(parseErrors).toHaveLength(1)
      // The transport recovers: the next frame starts a clean sequence.
      expect((await client.request({ type: 'get_state' })).success).toBe(true)
    }
  })

  it('subscribes to subagent progress before any other command, on v1 too', async () => {
    for (const env of [{}, { FAKE_OMP_NO_V2: '1' }] as Record<string, string>[]) {
      const client = makeOmp(env)
      client.spawn()
      const state = await client.request({ type: 'get_state' })
      const data = state.success ? (state.data as unknown as Record<string, unknown>) : {}
      const received = data.received as string[]
      expect(received.filter((type) => type !== 'negotiate_protocol')).toEqual([
        'set_subagent_subscription',
        'get_state',
      ])
      expect(client.subagentSubscription).toBe('progress')
    }
  })

  it('passes subagent frames on apart from events and drops updates to an ended call', async () => {
    const client = makeOmp({ FAKE_OMP_REPLAY: ompReplay })
    const events: PiEvent[] = []
    const frames: Array<{ type: string }> = []
    client.on('event', (event) => events.push(event))
    client.on('subagent', (frame) => frames.push(frame))
    client.spawn()
    const ended = nextEvent(client, 'agent_end')
    await client.request({ type: 'prompt', message: 'send two scouts' })
    await ended
    expect(frames.map((frame) => frame.type)).toEqual([
      'subagent_lifecycle',
      'subagent_lifecycle',
      'subagent_progress',
      'subagent_progress',
    ])
    expect(events.some((event) => event.type.startsWith('subagent'))).toBe(false)
    // omp keeps updating a background `task` after its end; the row must not reopen.
    const end = events.findIndex((event) => event.type === 'tool_execution_end')
    expect(end).toBeGreaterThan(-1)
    expect(events.slice(end).some((event) => event.type === 'tool_execution_update')).toBe(false)
    const running = await client.getSubagents()
    expect(
      running.map(({ id, status, parentToolCallId }) => ({ id, status, parentToolCallId })),
    ).toEqual([
      { id: 'ListElectron', status: 'running', parentToolCallId: 'toolu_01TaskScouts' },
      { id: 'ListSrc', status: 'running', parentToolCallId: 'toolu_01TaskScouts' },
    ])
  })
})
