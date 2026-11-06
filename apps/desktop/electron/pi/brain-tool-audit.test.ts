import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyBrainTools } from './brain-tool-audit'

const EXTENSION = '/owned/brain-processor.mjs'
function setup() {
  const events = new EventEmitter()
  const state = {
    emit: true,
    jobId: 'job-1',
    tools: ['brain_job', 'brain_propose'],
    disposition: 'handled',
    startInference: false,
    commands: [
      { name: 'phosphor-brain-audit', source: 'extension', sourceInfo: { path: EXTENSION } },
    ],
  }
  const request = vi.fn(async (command: { type: string; message?: string }) => {
    if (command.type === 'get_commands')
      return { success: true, data: { commands: state.commands } }
    const nonce = command.message!.split(' ')[1]
    if (state.emit)
      events.emit('extension-ui', {
        type: 'extension_ui_request',
        id: 'audit',
        method: 'setStatus',
        statusKey: 'phosphor-brain-audit',
        statusText: JSON.stringify({ version: 1, nonce, jobId: state.jobId, tools: state.tools }),
      })
    if (state.startInference) events.emit('event', { type: 'agent_start' })
    return { success: true, data: { disposition: state.disposition } }
  })
  const client = Object.assign(events, { request }) as unknown as Parameters<
    typeof verifyBrainTools
  >[0]
  const abort = new AbortController()
  const run = () => verifyBrainTools(client, 'job-1', EXTENSION, abort.signal, 100)
  const clean = () => {
    for (const event of ['extension-ui', 'event', 'exit'])
      expect(events.listenerCount(event)).toBe(0)
  }
  return { state, request, events, run, clean, abort }
}
afterEach(() => vi.useRealTimers())

describe('Brain local non-inference processor audit', () => {
  it('subscribes before the command and accepts only job/nonce-bound exact tools', async () => {
    const f = setup()
    await f.run()
    expect(f.request.mock.calls.map(([command]) => command.type)).toEqual([
      'get_commands',
      'prompt',
    ])
    expect(f.request.mock.calls[1]![0].message).toMatch(/^\/phosphor-brain-audit [a-f0-9]{32}$/)
    f.clean()
  })

  it.each(['missing', 'duplicate', 'other path', 'prompt template'])(
    'never prompts for %s audit commands',
    async (kind) => {
      const f = setup()
      if (kind === 'missing') f.state.commands = []
      if (kind === 'duplicate') f.state.commands.push(f.state.commands[0]!)
      if (kind === 'other path') f.state.commands[0]!.sourceInfo.path = '/other/brain-processor.mjs'
      if (kind === 'prompt template') f.state.commands[0]!.source = 'prompt'
      await expect(f.run()).rejects.toThrow('command is unavailable')
      expect(f.request).toHaveBeenCalledTimes(1)
      f.clean()
    },
  )

  it.each(['extra tools', 'wrong job', 'inference', 'not handled'])(
    'fails closed on %s',
    async (kind) => {
      const f = setup()
      if (kind === 'extra tools') f.state.tools.push('bash')
      if (kind === 'wrong job') f.state.jobId = 'other-job'
      if (kind === 'inference') f.state.startInference = true
      if (kind === 'not handled') f.state.disposition = 'started'
      await expect(f.run()).rejects.toThrow(/Brain/)
      f.clean()
    },
  )

  it('times out a missing attestation and removes every listener', async () => {
    vi.useFakeTimers()
    const f = setup()
    f.state.emit = false
    const outcome = f.run().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(101)
    expect(String(await outcome)).toMatch(/timed out/)
    f.clean()
  })

  it('cancellation never sends a late prompt after command discovery resolves', async () => {
    const f = setup()
    let resolve!: (value: { success: boolean; data: { commands: typeof f.state.commands } }) => void
    f.request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const outcome = f.run().catch((error: unknown) => error)
    f.abort.abort()
    expect(String(await outcome)).toMatch(/cancelled/)
    resolve({ success: true, data: { commands: f.state.commands } })
    await Promise.resolve()
    expect(f.request).toHaveBeenCalledTimes(1)
    f.clean()
  })

  it('refuses an exited process rather than waiting for status', async () => {
    const f = setup()
    f.state.emit = false
    const outcome = f.run().catch((error: unknown) => error)
    f.events.emit('exit', { code: 1, signal: null, expected: false })
    expect(String(await outcome)).toMatch(/exited/)
    expect(f.request).toHaveBeenCalledTimes(1)
    f.clean()
  })
})
