#!/usr/bin/env node
/**
 * Fake pi that speaks the MCP adapter's `/mcp reconnect` conversation, for
 * `connector-check.test.ts`. The verdict arrives as a `notify`, exactly as the
 * real adapter reports it. Behaviour is chosen by PHOSPHOR_FAKE_CHECK:
 *
 *   ok (default) — reconnected, with a tool count
 *   auth         — needs OAuth
 *   fail         — the server refused the connection
 *   noise        — only an unrelated notify (the timeout path)
 *   refuse       — reject the /mcp command outright
 *   prompt       — ask for input and never resolve; the client must not answer
 */
'use strict'

const mode = process.env.PHOSPHOR_FAKE_CHECK || 'ok'
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

let buffer = ''
let answered = false

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

const notify = (message) =>
  out({ type: 'extension_ui_request', id: 'ui-1', method: 'notify', message })

function handle(cmd) {
  if (cmd.type === 'extension_ui_response') {
    // Only the `prompt` mode cares: if the client answers, say so loudly so
    // the test can fail on it.
    if (mode === 'prompt' && !answered) {
      answered = true
      notify('MCP: Reconnected to answered (1 tools, 0 resources)')
    }
    return
  }

  if (cmd.type !== 'prompt') {
    out({ id: cmd.id, type: 'response', command: cmd.type, success: true })
    return
  }

  const server = (cmd.message || '').replace('/mcp reconnect ', '').trim()
  if (mode === 'refuse') {
    out({
      id: cmd.id,
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'Unknown command: /mcp',
    })
    return
  }

  out({ id: cmd.id, type: 'response', command: 'prompt', success: true })

  if (mode === 'ok') {
    setTimeout(() => {
      notify(`MCP: ${server} - 2 tools skipped`)
      notify(`MCP: Reconnected to ${server} (42 tools, 3 resources)`)
    }, 20)
  }
  if (mode === 'auth') {
    setTimeout(() => notify(`MCP: ${server} requires OAuth. Run /mcp-auth ${server} first.`), 20)
  }
  if (mode === 'fail') {
    setTimeout(() => notify(`MCP: Failed to reconnect to ${server}: fetch failed (ENOTFOUND)`), 20)
  }
  if (mode === 'noise') {
    setTimeout(() => notify(`MCP: ${server} - 2 tools skipped`), 20)
  }
  if (mode === 'prompt') {
    setTimeout(
      () =>
        out({
          type: 'extension_ui_request',
          id: 'ui-input',
          method: 'input',
          title: `Complete ${server} OAuth\n\nhttps://provider.test/authorize\n`,
        }),
      20,
    )
  }
}
