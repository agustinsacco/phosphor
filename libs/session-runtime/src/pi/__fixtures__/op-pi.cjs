#!/usr/bin/env node
/**
 * Fake pi for the op channel. Behaves like pi 1.5.2 where it matters
 * (spikes/S2): an editor request stays pending until its id is answered, a
 * second answer to the same id is ignored, and `abort` is acknowledged only
 * once no editor is pending.
 *
 * `prompt` with a JSON message `{requests, exitAfterMs?}` emits those
 * extension UI requests; any other message emits one op request built from
 * `OP_PI_PREFILL` (or a default). The turn ends when every request is
 * answered. Each received answer is echoed as a `fake_ui_response` record.
 */
'use strict'

const { StringDecoder } = require('node:string_decoder')

const decoder = new StringDecoder('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += decoder.write(chunk)
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.length > 0) handle(JSON.parse(line))
  }
})

const out = (record) => process.stdout.write(JSON.stringify(record) + '\n')
const ok = (cmd, data) =>
  out({ id: cmd.id, type: 'response', command: cmd.type, success: true, data })

/** Editor ids awaiting an answer, in emission order. */
const pending = new Set()
const answered = new Set()
const replies = []
let heldAbort = null
let turnOpen = false

const DEFAULT_PREFILL = JSON.stringify({ v: 1, id: 'op-1', argv: ['help'], deadlineMs: 30_000 })

function state(cmd) {
  ok(cmd, {
    model: { provider: 'test', id: 'model' },
    thinkingLevel: 'off',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'one-at-a-time',
    sessionId: 'op-session',
    sessionFile: '/fake/op-session.jsonl',
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
    // Test probe: the marker as this process received it.
    opsMarker: process.env.PHOSPHOR_OPS ?? null,
  })
}

function requestsFor(message) {
  if (message.startsWith('{')) return JSON.parse(message)
  return {
    requests: [
      {
        id: 'editor-1',
        method: 'editor',
        title: 'phosphor-op/v1',
        prefill: process.env.OP_PI_PREFILL ?? DEFAULT_PREFILL,
      },
    ],
  }
}

function prompt(cmd) {
  ok(cmd)
  const script = requestsFor(cmd.message)
  out({ type: 'agent_start' })
  turnOpen = true
  for (const request of script.requests) {
    pending.add(request.id)
    out({ type: 'extension_ui_request', ...request })
  }
  if (script.exitAfterMs !== undefined) setTimeout(() => process.exit(0), script.exitAfterMs)
  settle()
}

function settle() {
  if (pending.size > 0) return
  if (heldAbort) {
    ok(heldAbort)
    heldAbort = null
  }
  if (!turnOpen) return
  turnOpen = false
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: `replies: ${replies.join(' | ')}` }],
    stopReason: 'stop',
  }
  out({ type: 'message_end', message })
  out({ type: 'agent_end', messages: [message] })
}

function uiResponse(response) {
  out({ type: 'fake_ui_response', response, duplicate: answered.has(response.id) })
  if (!pending.has(response.id)) return
  pending.delete(response.id)
  answered.add(response.id)
  replies.push(response.value ?? JSON.stringify(response))
  settle()
}

function handle(cmd) {
  if (cmd.type === 'extension_ui_response') return uiResponse(cmd)
  if (cmd.type === 'get_state') return state(cmd)
  if (cmd.type === 'prompt') return prompt(cmd)
  if (cmd.type === 'abort') {
    heldAbort = cmd
    return settle()
  }
  ok(cmd)
}

process.on('SIGTERM', () => process.exit(0))
