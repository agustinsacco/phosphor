#!/usr/bin/env node
/**
 * A stand-in for the `headroom` binary, faithful to the two things Phosphor
 * actually depends on: the CLI contract (`proxy --host … --port …`, privacy
 * env) and the HTTP contract (`GET /health`, `POST /v1/compress`).
 *
 * The compressor is a real, lossless restructure — the same shape Headroom
 * 0.37.0's SmartCrusher returns for a uniform JSON array ("[n]{field:type,…}"
 * plus one CSV row per record), copied from a captured live response
 * (electron/pi/__fixtures__/headroom-live-session.jsonl). That matters: the
 * chain test asserts no record is lost, which is only a real assertion if the
 * transform genuinely rewrites the payload.
 *
 * Deliberately strict about its own argv and env. A contract drift in
 * proxyArgs()/proxyEnv() must fail the test loudly, not quietly serve anyway.
 */
'use strict'

const http = require('node:http')

const args = process.argv.slice(2)
function fail(message) {
  process.stderr.write(`fake-headroom: ${message}\n`)
  process.exit(2)
}

if (args[0] !== 'proxy') fail(`expected the "proxy" subcommand, got ${JSON.stringify(args)}`)
const host = args[args.indexOf('--host') + 1]
const port = Number(args[args.indexOf('--port') + 1])
if (host !== '127.0.0.1') fail(`refusing a non-loopback bind: ${host}`)
if (!Number.isInteger(port)) fail('no --port')
if (!args.includes('--no-subscription-tracking')) fail('subscription tracking was left on')

for (const [key, want] of [
  ['HEADROOM_BEACON', 'off'],
  ['DO_NOT_TRACK', '1'],
  ['HEADROOM_UPDATE_CHECK', 'off'],
  ['HEADROOM_COMPRESSORS', 'smart_crusher,tabular'],
  ['HEADROOM_HOST', '127.0.0.1'],
]) {
  if (process.env[key] !== want) fail(`env ${key} was ${String(process.env[key])}, wanted ${want}`)
}

/** Rough token count, the way a proxy reports one. Only the ratio matters. */
const tokens = (text) => Math.ceil(text.length / 4)

/**
 * Uniform array of flat objects → typed header + CSV rows. Anything else is
 * returned untouched, which is upstream's `router:noop`.
 */
function compress(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return text
  const keys = [...new Set(parsed.flatMap((row) => Object.keys(row ?? {})))].sort()
  const uniform = parsed.every(
    (row) => row && typeof row === 'object' && !Array.isArray(row) && keys.length > 1,
  )
  if (!uniform) return text
  const type = (key) => {
    const sample = parsed.find((row) => row[key] !== undefined && row[key] !== null)?.[key]
    const base = typeof sample === 'number' ? 'int' : typeof sample
    return parsed.some((row) => row[key] === undefined || row[key] === null) ? `${base}?` : base
  }
  const header = `[${parsed.length}]{${keys.map((k) => `${k}:${type(k)}`).join(',')}}`
  const rows = parsed.map((row) => keys.map((k) => String(row[k] ?? '')).join(','))
  return [header, ...rows].join('\n')
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', checks: { kompress: { ready: true } } }))
    return
  }
  if (req.method !== 'POST' || req.url !== '/v1/compress') {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const request = JSON.parse(body)
    const original = String(request.messages?.[0]?.content ?? '')
    // `__lossy__` asks for the shape Phosphor must refuse: an omission marker
    // with no retrievable hash. Upstream's text compressors emit exactly this.
    const compressed = original.includes('"__lossy__"')
      ? '[2711 lines omitted: 3 ERROR, 2725 INFO]\nkept the last line'
      : compress(original)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        messages: [{ role: 'tool', content: compressed }],
        tokens_before: tokens(original),
        tokens_after: tokens(compressed),
        tokens_saved: tokens(original) - tokens(compressed),
      }),
    )
  })
})

server.listen(port, host)
