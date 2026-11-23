import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { PiRpcClient, type PiRpcRuntime } from './rpc-client'

// Importing the core must not evaluate Electron, directly or through its logger.
vi.mock('electron', () => {
  throw new Error('The headless RPC transport imported Electron')
})

const clients: PiRpcClient[] = []
function client(runtime: PiRpcRuntime): PiRpcClient {
  const instance = new PiRpcClient(
    {
      cwd: import.meta.dirname,
      binaryPath: process.execPath,
      prefixArgs: [join(import.meta.dirname, '__fixtures__', 'fake-pi.cjs')],
    },
    runtime,
  )
  clients.push(instance)
  instance.spawn()
  return instance
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((instance) => instance.dispose()))
})

describe('headless PiRpcClient', () => {
  it('redacts appended prompt values in spawn logs without hiding the flag', async () => {
    const log = vi.fn()
    const instance = new PiRpcClient(
      {
        cwd: import.meta.dirname,
        binaryPath: process.execPath,
        prefixArgs: [join(import.meta.dirname, '__fixtures__', 'fake-pi.cjs')],
        appendSystemPrompt: '<phosphor_machine>private display names</phosphor_machine>',
      },
      { log, isClosing: () => false },
    )
    clients.push(instance)
    instance.spawn()
    await instance.request({ type: 'get_state' })
    expect(log).toHaveBeenCalledWith(
      'pi',
      'spawn',
      expect.objectContaining({
        args: expect.arrayContaining(['--append-system-prompt', '[redacted]']),
      }),
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain('private display names')
  })

  it('runs RPC and streams events without Electron or a global logger', async () => {
    const log = vi.fn()
    const instance = client({ log, isClosing: () => false })
    const events: string[] = []
    const ended = new Promise<void>((resolve) => {
      instance.on('event', (event) => {
        events.push(event.type)
        if (event.type === 'agent_end') resolve()
      })
    })
    expect((await instance.request({ type: 'get_state' })).success).toBe(true)
    expect(instance.piSessionId).toBe('fake-session')
    expect(instance.sessionFile).toBe('/fake/session.jsonl')
    expect((await instance.request({ type: 'prompt', message: 'hello' })).success).toBe(true)
    await ended
    expect(events).toContain('message_update')
    expect(log).toHaveBeenCalledWith(
      'pi',
      'spawn',
      expect.objectContaining({ cwd: import.meta.dirname }),
    )
  })

  it('reports each response as pi prints it, in order with the events around it', async () => {
    const instance = client({ log: vi.fn(), isClosing: () => false })
    const order: string[] = []
    instance.on('response', (response) => order.push(`response ${response.command}`))
    const ended = new Promise<void>((resolve) => {
      instance.on('event', (event) => {
        order.push(event.type)
        if (event.type === 'agent_end') resolve()
      })
    })
    await instance.request({ type: 'get_state' })
    await instance.request({ type: 'prompt', message: 'hello' })
    await ended
    expect(order.slice(0, 3)).toEqual(['response get_state', 'response prompt', 'agent_start'])
  })

  it('keeps shutdown and logging scoped to the supplied runtime', async () => {
    let closing = false
    const firstLog = vi.fn()
    const secondLog = vi.fn()
    const first = client({ log: firstLog, isClosing: () => closing })
    const second = client({ log: secondLog, isClosing: () => false })
    closing = true
    await expect(first.request({ type: 'prompt', message: 'blocked' })).rejects.toThrow(
      'shutting down',
    )
    expect((await first.request({ type: 'get_state' })).success).toBe(true)
    expect((await first.request({ type: 'abort' })).success).toBe(true)
    expect((await second.request({ type: 'prompt', message: 'allowed' })).success).toBe(true)
    expect(firstLog).toHaveBeenCalledWith('pi', 'abort', expect.any(Object))
    expect(secondLog).not.toHaveBeenCalledWith('pi', 'abort', expect.anything())
  })

  it('gives pi only the supplied environment when inheritEnv is false', async () => {
    // Reports which variables it can see, then waits to be disposed.
    const probe = [
      "process.stderr.write('PROBE ' + JSON.stringify({",
      '  inherited: process.env.PHOSPHOR_RPC_SENTINEL ?? null,',
      '  given: process.env.PHOSPHOR_RPC_GIVEN ?? null,',
      "}) + '\\n')",
      'process.stdin.resume()',
    ].join('\n')
    const seen = (inheritEnv?: boolean) =>
      new Promise<unknown>((resolve) => {
        const instance = new PiRpcClient(
          {
            cwd: import.meta.dirname,
            binaryPath: process.execPath,
            prefixArgs: ['-e', probe, '--'],
            env: { PHOSPHOR_RPC_GIVEN: 'given' },
            ...(inheritEnv === undefined ? {} : { inheritEnv }),
          },
          { log: vi.fn(), isClosing: () => false },
        )
        clients.push(instance)
        instance.on('stderr', (line) => {
          if (line.startsWith('PROBE ')) resolve(JSON.parse(line.slice('PROBE '.length)))
        })
        instance.spawn()
      })
    process.env.PHOSPHOR_RPC_SENTINEL = 'inherited'
    try {
      expect(await seen(false)).toEqual({ inherited: null, given: 'given' })
      expect(await seen()).toEqual({ inherited: 'inherited', given: 'given' })
    } finally {
      delete process.env.PHOSPHOR_RPC_SENTINEL
    }
  })

  it('passes each extension with -e and each skill with --skill', async () => {
    const probe =
      "process.stderr.write('ARGS ' + JSON.stringify(process.argv.slice(1)) + '\\n'); process.stdin.resume()"
    const args = await new Promise<string[]>((resolve) => {
      const instance = new PiRpcClient(
        {
          cwd: import.meta.dirname,
          binaryPath: process.execPath,
          prefixArgs: ['-e', probe, '--'],
          extensions: ['/res/brain.mjs'],
          skills: ['/res/skills/brain'],
        },
        { log: vi.fn(), isClosing: () => false },
      )
      clients.push(instance)
      instance.on('stderr', (line) => {
        if (line.startsWith('ARGS ')) resolve(JSON.parse(line.slice('ARGS '.length)))
      })
      instance.spawn()
    })
    expect(args.join(' ')).toContain('-e /res/brain.mjs --skill /res/skills/brain')
  })
})

// Exercise stdout routing, including requests that do not open a modal.
it('tracks every extension UI record before forwarding it unchanged', async () => {
  const records = [
    { method: 'input', title: 'Name' },
    { method: 'select', title: 'Pick', options: ['One'] },
    { method: 'confirm', title: 'Continue?', message: 'Question' },
    { method: 'editor', title: 'Edit', prefill: 'draft' },
    { method: 'notify', message: 'Done' },
    { method: 'setStatus', statusKey: 'progress', statusText: 'Done' },
    { method: 'setWidget', widgetKey: 'progress', widgetLines: ['Done'] },
    { method: 'setTitle', title: 'Done' },
    { method: 'set_editor_text', text: 'draft' },
    { method: 'future-method' },
  ].map((fields, i) => ({ type: 'extension_ui_request', id: `ui-${i}`, ...fields }))
  const jsonl = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  const instance = new PiRpcClient(
    {
      cwd: import.meta.dirname,
      binaryPath: process.execPath,
      inheritEnv: false,
      prefixArgs: [
        '-e',
        'process.stdout.write(process.argv[1]); process.stdin.resume()',
        '--',
        jsonl,
      ],
    },
    { log: vi.fn(), isClosing: () => false },
  )
  clients.push(instance)
  const dialog = vi.spyOn(instance.activity, 'dialog')
  const forwarded = vi.fn()
  instance.on('extension-ui', forwarded)
  instance.spawn()
  await vi.waitFor(() => expect(forwarded).toHaveBeenCalledTimes(records.length))
  expect(dialog.mock.calls).toEqual(records.map((record) => [record]))
  expect(forwarded.mock.calls).toEqual(dialog.mock.calls)
  for (const [i, order] of dialog.mock.invocationCallOrder.entries())
    expect(order).toBeLessThan(forwarded.mock.invocationCallOrder[i]!)
})
