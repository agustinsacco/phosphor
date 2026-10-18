#!/usr/bin/env node
/**
 * Fake pi RPC server for PiRpcClient tests.
 * Speaks just enough of the protocol: correlated responses, streamed events,
 * deliberate protocol quirks (U+2028 in deltas, chunked writes, out-of-order
 * responses), and crash-on-command.
 */
'use strict'

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) !== -1) {
    let line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line.length > 0) handle(JSON.parse(line))
  }
})

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

/** Write a record split across two chunks with a delay, to exercise buffering. */
function outChunked(obj) {
  const raw = JSON.stringify(obj) + '\n'
  const mid = Math.floor(raw.length / 2)
  process.stdout.write(raw.slice(0, mid))
  setTimeout(() => process.stdout.write(raw.slice(mid)), 5)
}

let delayedResponse = null

function stateResponse(cmd) {
  out({
    id: cmd.id,
    type: 'response',
    command: 'get_state',
    success: true,
    data: {
      thinkingLevel: 'off',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'one-at-a-time',
      sessionId: 'fake-session',
      sessionFile: process.env.FAKE_PI_SESSION_FILE ?? '/fake/session.jsonl',
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    },
  })
}

function promptEvents(cmd) {
  out({ id: cmd.id, type: 'response', command: 'prompt', success: true })
  // The service stages this extension command during readiness/preflight.
  // It is not a model turn and must not emit artificial overlapping turns.
  if (cmd.message.startsWith('/phosphor-context-budget ')) return
  out({ type: 'agent_start' })
  out({ type: 'message_start', message: { role: 'assistant', content: [] } })
  // Delta containing U+2028 — must arrive inside one record.
  outChunked({
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello world' },
  })
  setTimeout(() => {
    out({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
        stopReason: 'stop',
      },
    })
    out({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] }],
    })
  }, 20)
}

function modelsResponse(cmd) {
  // Test hook: simulate a hang (no response ever sent).
  if (process.env.FAKE_PI_HANG_MODELS) return
  out({
    id: cmd.id,
    type: 'response',
    command: 'get_available_models',
    success: true,
    data: {
      models: [
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
      ],
    },
  })
}

function releaseDelayed(cmd) {
  // Answer the held command AFTER this one → out-of-order correlation.
  out({ id: cmd.id, type: 'response', command: 'abort', success: true })
  if (delayedResponse) {
    out(delayedResponse)
    delayedResponse = null
  }
}

const commandHandlers = {
  get_state: stateResponse,
  prompt: promptEvents,
  get_available_models: modelsResponse,
  abort: releaseDelayed,
  compact: (cmd) => {
    // Test hook: hold this response until abort arrives.
    delayedResponse = {
      id: cmd.id,
      type: 'response',
      command: 'compact',
      success: true,
      data: { summary: 'S', firstKeptEntryId: 'x', tokensBefore: 1 },
    }
  },
  set_model: (cmd) => {
    out({
      id: cmd.id,
      type: 'response',
      command: 'set_model',
      success: false,
      error: 'Model not found: ' + cmd.modelId,
    })
  },
  bash: (cmd) => {
    if (cmd.command === 'CRASH') process.exit(3)
    out({
      id: cmd.id,
      type: 'response',
      command: 'bash',
      success: true,
      data: { output: 'ok', exitCode: 0, cancelled: false, truncated: false },
    })
  },
}

function handle(cmd) {
  if (typeof cmd.type === 'string' && Object.hasOwn(commandHandlers, cmd.type)) {
    commandHandlers[cmd.type](cmd)
    return
  }
  out({
    id: cmd.id,
    type: 'response',
    command: cmd.type,
    success: false,
    error: 'unsupported in fake',
  })
}

process.on('SIGTERM', () => process.exit(0))
