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
  const records: unknown[] = []
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

const state = {
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'one-at-a-time',
  sessionId: 'fake-session',
  sessionFile: '/fake/session.jsonl',
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
}
const models = [
  {
    id: 'us.anthropic.claude-opus-5',
    name: 'Claude Opus 5 (US)',
    api: 'bedrock-converse-stream',
    provider: 'amazon-bedrock',
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: 'Qwen 3.5 122b',
    name: 'Qwen 3.5 122b',
    api: 'openai-completions',
    provider: 'local-stark',
    reasoning: false,
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
]
const content = [{ type: 'text', text: 'Hello\u2028world' }]

describe('fake-pi stdout characterization', () => {
  it('freezes the state, models, error and bash response matrix', async () => {
    const pi = fixture()
    for (const command of [
      { id: 's', type: 'get_state' },
      { id: 'm', type: 'get_available_models' },
      { id: 'e', type: 'set_model', modelId: 'missing' },
      { id: 'b', type: 'bash', command: 'ok' },
      { id: 'u', type: 'unknown' },
    ])
      pi.send(command)
    await pi.wait(5)
    expect(pi.records).toEqual([
      { id: 's', type: 'response', command: 'get_state', success: true, data: state },
      {
        id: 'm',
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models },
      },
      {
        id: 'e',
        type: 'response',
        command: 'set_model',
        success: false,
        error: 'Model not found: missing',
      },
      {
        id: 'b',
        type: 'response',
        command: 'bash',
        success: true,
        data: { output: 'ok', exitCode: 0, cancelled: false, truncated: false },
      },
      {
        id: 'u',
        type: 'response',
        command: 'unknown',
        success: false,
        error: 'unsupported in fake',
      },
    ])
  })

  it('freezes prompt acknowledgement and the complete ordered U+2028 event stream', async () => {
    const pi = fixture()
    pi.send({ id: 'p', type: 'prompt', message: 'hello' })
    await pi.wait(6)
    expect(pi.records).toEqual([
      { id: 'p', type: 'response', command: 'prompt', success: true },
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      {
        type: 'message_update',
        message: { role: 'assistant', content },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello\u2028world' },
      },
      { type: 'message_end', message: { role: 'assistant', content, stopReason: 'stop' } },
      { type: 'agent_end', messages: [{ role: 'assistant', content }] },
    ])
  })

  it('acknowledges context-budget without a turn and hangs model queries without blocking state', async () => {
    const pi = fixture({ FAKE_PI_HANG_MODELS: '1', FAKE_PI_SESSION_FILE: '/custom/session.jsonl' })
    pi.send({ id: 'p', type: 'prompt', message: '/phosphor-context-budget 200000' })
    pi.send({ id: 'm', type: 'get_available_models' })
    pi.send({ id: 's', type: 'get_state' })
    await pi.wait(2)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(pi.records).toEqual([
      { id: 'p', type: 'response', command: 'prompt', success: true },
      {
        id: 's',
        type: 'response',
        command: 'get_state',
        success: true,
        data: { ...state, sessionFile: '/custom/session.jsonl' },
      },
    ])
  })

  it('holds compact across state, then answers abort before compact and releases only once', async () => {
    const pi = fixture()
    pi.send({ id: 'c', type: 'compact' })
    pi.send({ id: 's', type: 'get_state' })
    await pi.wait(1)
    expect(pi.records).toEqual([
      { id: 's', type: 'response', command: 'get_state', success: true, data: state },
    ])
    pi.send({ id: 'a', type: 'abort' })
    pi.send({ id: 'a2', type: 'abort' })
    await pi.wait(4)
    expect(pi.records.slice(1)).toEqual([
      { id: 'a', type: 'response', command: 'abort', success: true },
      {
        id: 'c',
        type: 'response',
        command: 'compact',
        success: true,
        data: { summary: 'S', firstKeptEntryId: 'x', tokensBefore: 1 },
      },
      { id: 'a2', type: 'response', command: 'abort', success: true },
    ])
  })

  it('crashes with code 3 and no response to the crash command', async () => {
    const pi = fixture()
    const closed = once(pi.child, 'close')
    pi.send({ id: 'b', type: 'bash', command: 'CRASH' })
    expect(await closed).toEqual([3, null])
    expect(pi.records).toEqual([])
  })
})
