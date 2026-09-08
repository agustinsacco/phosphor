#!/usr/bin/env node
/**
 * Fake pi that speaks the MCP adapter's OAuth conversation, for
 * `connector-auth.test.ts`.
 *
 * It reproduces the two things that make the real flow hard: the authorization
 * prompt is an `extension_ui_request` the client is *not* supposed to answer,
 * and the outcome arrives later as a `notify`. Behaviour is chosen by
 * PHOSPHOR_FAKE_AUTH:
 *
 *   callback (default) — prompt, then succeed on its own (the loopback
 *                        callback winning the race), leaving the prompt unanswered
 *   manual            — prompt, then succeed only after the client answers it
 *   refuse            — reject the /mcp-auth command outright
 *   fail              — prompt, then report failure
 *   silent            — prompt and never resolve (timeout path)
 */
'use strict'

const mode = process.env.PHOSPHOR_FAKE_AUTH || 'callback'
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

let buffer = ''
let promptId = null

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (line.trim().length > 0) handle(JSON.parse(line))
  }
})

function askForAuthorization(server) {
  promptId = 'ui-1'
  out({
    type: 'extension_ui_request',
    id: promptId,
    method: 'input',
    title:
      `Complete ${server} OAuth\n\n` +
      `https://provider.test/oauth/authorize?client_id=abc&state=xyz\n\n` +
      'Approve access, then paste the full localhost callback URL below.',
  })
}

function succeed(server) {
  out({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'notify',
    message: `OAuth authentication successful for "${server}".`,
  })
}

function handle(cmd) {
  if (cmd.type === 'extension_ui_response') {
    // Only the manual mode cares: the client answered the prompt.
    if (mode === 'manual' && cmd.id === promptId && typeof cmd.value === 'string') {
      out({
        type: 'extension_ui_request',
        id: 'ui-3',
        method: 'notify',
        message: cmd.value.includes('code=')
          ? 'OAuth authentication successful for "acme".'
          : 'OAuth authentication failed for "acme".',
      })
    }
    if (mode === 'cancel-report' && cmd.cancelled) {
      process.stderr.write('cancelled\n')
    }
    return
  }

  if (cmd.type !== 'prompt') {
    out({ id: cmd.id, type: 'response', command: cmd.type, success: true })
    return
  }

  const server = (cmd.message || '').replace('/mcp-auth ', '').trim()
  if (mode === 'refuse') {
    out({
      id: cmd.id,
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'Unknown command: /mcp-auth',
    })
    return
  }

  out({ id: cmd.id, type: 'response', command: 'prompt', success: true })
  askForAuthorization(server)

  if (mode === 'callback') setTimeout(() => succeed(server), 20)
  if (mode === 'fail') {
    setTimeout(
      () =>
        out({
          type: 'extension_ui_request',
          id: 'ui-2',
          method: 'notify',
          message: `Failed to authenticate "${server}": redirect_uri mismatch`,
        }),
      20,
    )
  }
}
