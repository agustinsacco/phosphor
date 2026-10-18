import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const children: ChildProcessWithoutNullStreams[] = []
function fixture(env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [join(import.meta.dirname, '__fixtures__/fake-pi.cjs')], {
    env: {
      ...process.env,
      FAKE_PI_HANG_MODELS: undefined,
      FAKE_PI_SESSION_FILE: undefined,
      ...env,
    },
  })
  children.push(child)
  const records: Record<string, unknown>[] = []
  let buffer = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n')) !== -1) {
      records.push(JSON.parse(buffer.slice(0, end)))
      buffer = buffer.slice(end + 1)
    }
  })
  return {
    child,
    records,
    send: (command: object) => child.stdin.write(JSON.stringify(command) + '\n'),
    wait: (count: number) => vi.waitFor(() => expect(records).toHaveLength(count)),
  }
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const closed = once(child, 'close')
      child.kill('SIGTERM')
      await closed
    }),
  )
})

describe('fake-pi command dispatch', () => {
  it('buffers partial stdin until LF, ignores blank lines and accepts CRLF', async () => {
    const pi = fixture()
    pi.send({ id: 'ready', type: 'get_state' })
    await pi.wait(1)
    pi.child.stdin.write('\n\r\n{"id":"partial","type":"get_sta')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(pi.records).toHaveLength(1)
    pi.child.stdin.write('te"}\r')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(pi.records).toHaveLength(1)
    pi.child.stdin.write('\n')
    await pi.wait(2)
    expect(pi.records[1]).toMatchObject({ id: 'partial', command: 'get_state', success: true })
  })

  it('does not treat U+2028 inside stdin JSON as a record separator', async () => {
    const pi = fixture()
    pi.send({ id: 'prompt', type: 'prompt', message: 'hello\u2028world' })
    await pi.wait(6)
    expect(pi.records.map((record) => record.type)).toEqual([
      'response',
      'agent_start',
      'message_start',
      'message_update',
      'message_end',
      'agent_end',
    ])
    expect(pi.records[3]).toMatchObject({
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello\u2028world' },
    })
    expect(pi.records[5]).toMatchObject({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello\u2028world' }] }],
    })
  })

  it('ignores an unterminated stdin record at EOF', async () => {
    const pi = fixture()
    const closed = once(pi.child, 'close')
    pi.child.stdin.end('{"id":"incomplete","type":"get_state"}')
    expect(await closed).toEqual([0, null])
    expect(pi.records).toEqual([])
  })

  it('keeps state and models handlers independently responsive', async () => {
    const pi = fixture({ FAKE_PI_SESSION_FILE: '/dispatch/session.jsonl' })
    pi.send({ id: 'state', type: 'get_state' })
    pi.send({ id: 'models', type: 'get_available_models' })
    await pi.wait(2)
    expect(pi.records[0]).toMatchObject({
      id: 'state',
      success: true,
      data: { sessionFile: '/dispatch/session.jsonl' },
    })
    expect(pi.records[1]).toMatchObject({
      id: 'models',
      success: true,
      data: {
        models: [
          { provider: 'amazon-bedrock', reasoning: true },
          { provider: 'local-stark', reasoning: false },
        ],
      },
    })
  })

  it('keeps the held compact response through unrelated commands and replaces it on another compact', async () => {
    const pi = fixture()
    pi.send({ id: 'old', type: 'compact' })
    pi.send({ id: 'latest', type: 'compact' })
    pi.send({ id: 'bash', type: 'bash', command: 'echo ok' })
    await pi.wait(1)
    expect(pi.records[0]).toEqual({
      id: 'bash',
      type: 'response',
      command: 'bash',
      success: true,
      data: { output: 'ok', exitCode: 0, cancelled: false, truncated: false },
    })
    pi.send({ id: 'abort', type: 'abort' })
    await pi.wait(3)
    expect(pi.records.slice(1).map((record) => record.id)).toEqual(['abort', 'latest'])
    expect(pi.records[2]).toMatchObject({
      command: 'compact',
      data: { summary: 'S', firstKeptEntryId: 'x', tokensBefore: 1 },
    })
  })

  it('skips model responses and context-budget turns without blocking dispatch', async () => {
    const pi = fixture({ FAKE_PI_HANG_MODELS: '1' })
    pi.send({ id: 'models', type: 'get_available_models' })
    pi.send({ id: 'budget', type: 'prompt', message: '/phosphor-context-budget 123' })
    pi.send({ id: 'abort', type: 'abort' })
    await pi.wait(2)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(pi.records).toEqual([
      { id: 'budget', type: 'response', command: 'prompt', success: true },
      { id: 'abort', type: 'response', command: 'abort', success: true },
    ])
  })

  it.each(['unsupported', '__proto__', 'constructor', 'toString'])(
    'returns the unsupported response for %s without invoking inherited table properties',
    async (type) => {
      const pi = fixture()
      pi.send({ id: 'unknown', type })
      pi.send({ id: 'model', type: 'set_model', modelId: 'absent' })
      await pi.wait(2)
      expect(pi.records).toEqual([
        {
          id: 'unknown',
          type: 'response',
          command: type,
          success: false,
          error: 'unsupported in fake',
        },
        {
          id: 'model',
          type: 'response',
          command: 'set_model',
          success: false,
          error: 'Model not found: absent',
        },
      ])
    },
  )

  it('does not coerce non-string command types into handler names', async () => {
    const pi = fixture()
    pi.send({ id: 'array', type: ['get_state'] })
    await pi.wait(1)
    expect(pi.records).toEqual([
      {
        id: 'array',
        type: 'response',
        command: ['get_state'],
        success: false,
        error: 'unsupported in fake',
      },
    ])
  })

  it('preserves crash and graceful SIGTERM exit controls', async () => {
    const crash = fixture()
    const crashed = once(crash.child, 'close')
    crash.send({ id: 'crash', type: 'bash', command: 'CRASH' })
    expect(await crashed).toEqual([3, null])
    expect(crash.records).toEqual([])
    const graceful = fixture()
    graceful.send({ id: 'ready', type: 'get_state' })
    await graceful.wait(1)
    const closed = once(graceful.child, 'close')
    graceful.child.kill('SIGTERM')
    expect(await closed).toEqual([0, null])
  })
})
