import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { McpInspector, type McpInspectorCli } from './mcp-inspection'

const cli: McpInspectorCli = {
  binaryPath: process.execPath,
  prefixArgs: [join(__dirname, '__fixtures__/mcp-inspection.cjs')],
  cwd: __dirname,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
}
let inspector: McpInspector
let directory: string | undefined
afterEach(async () => {
  await inspector?.dispose(true)
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

it('returns metadata early and drains credential cleanup on normal shutdown', async () => {
  inspector = new McpInspector()
  directory = await mkdtemp(join(tmpdir(), 'mcp-inspect-'))
  const marker = join(directory, 'events')
  const result = await inspector.check(
    { ...cli, env: { ...cli.env, MCP_TEST_MARKER: marker } },
    'pagerduty',
    new AbortController().signal,
  )
  expect(result.ok).toBe(true)
  expect(await readFile(marker, 'utf8')).toBe('start pagerduty\n')
  await inspector.dispose()
  expect(await readFile(marker, 'utf8')).toBe('start pagerduty\nend pagerduty\n')
})
it('decodes UTF-8 metadata split across native stdout chunks', async () => {
  inspector = new McpInspector()
  const result = await inspector.check(cli, 'unicode', new AbortController().signal)
  expect(result).toMatchObject({
    ok: true,
    report: { tools: [{ description: 'Réparer incidents' }] },
  })
})
it('detects unsupported pi without leaking stderr, and rejects malformed reports', async () => {
  inspector = new McpInspector()
  const signal = new AbortController().signal
  const old = await inspector.check(cli, 'old', signal)
  expect(old).toMatchObject({ ok: false, unsupported: true })
  expect(JSON.stringify(old)).not.toContain('secret-value')
  expect(await inspector.check(cli, 'malformed', signal)).toMatchObject({ ok: false })
})
it('settles the UI on timeout and cancels queued work', async () => {
  inspector = new McpInspector({ displayTimeoutMs: 100, cleanupTimeoutMs: 250 })
  const signal = new AbortController().signal
  const first = Array.from({ length: 3 }, () => inspector.check(cli, 'hang', signal))
  const cancelled = new AbortController()
  const queued = inspector.check(cli, 'never-started', cancelled.signal)
  cancelled.abort()
  expect(await queued).toEqual({ ok: false, message: 'Check cancelled.' })
  expect(await Promise.all(first)).toEqual(
    Array.from({ length: 3 }, () => ({
      ok: false,
      message:
        'Check timed out. Native pi may still be finishing credential cleanup; retry shortly.',
    })),
  )
})
it('counts draining processes in its concurrency limit', async () => {
  inspector = new McpInspector()
  directory = await mkdtemp(join(tmpdir(), 'mcp-inspect-'))
  const marker = join(directory, 'events')
  const target = { ...cli, env: { ...cli.env, MCP_TEST_MARKER: marker } }
  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      inspector.check(target, `server${index}`, new AbortController().signal),
    ),
  )
  const events = (await readFile(marker, 'utf8')).trim().split('\n')
  let active = 0
  for (const event of events) {
    active += event.startsWith('start') ? 1 : -1
    expect(active).toBeLessThanOrEqual(3)
  }
  expect(events.filter((event) => event.startsWith('start'))).toHaveLength(5)
})
it('refuses invalid names and work after shutdown', async () => {
  inspector = new McpInspector()
  expect(await inspector.check(cli, 'invalid name', new AbortController().signal)).toMatchObject({
    ok: false,
  })
  await inspector.dispose()
  expect(await inspector.check(cli, 'pagerduty', new AbortController().signal)).toEqual({
    ok: false,
    message: 'Check cancelled.',
  })
})
