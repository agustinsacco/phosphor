import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { checkConnector } from './connector-check'

const here = dirname(fileURLToPath(import.meta.url))
const fakePi = join(here, '__fixtures__', 'fake-mcp-check-pi.cjs')

vi.mock('../debug-log', () => ({ log: () => {} }))

const check = (mode: string, timeoutMs = 5000): ReturnType<typeof checkConnector> =>
  checkConnector({
    serverName: 'acme',
    cwd: here,
    binaryPath: process.execPath,
    prefixArgs: [fakePi],
    env: { PHOSPHOR_FAKE_CHECK: mode },
    timeoutMs,
  })

describe('headless connector check', () => {
  it('reports a live connection and its tool count', async () => {
    expect(await check('ok')).toEqual({
      serverName: 'acme',
      outcome: 'connected',
      toolCount: 42,
      resourceCount: 3,
    })
  })

  it('separates a missing credential from an unreachable server', async () => {
    expect((await check('auth')).outcome).toBe('needs-auth')
    const failed = await check('fail')
    expect(failed.outcome).toBe('failed')
    expect(failed.detail).toBe('fetch failed (ENOTFOUND)')
  })

  it('degrades to unknown rather than guessing', async () => {
    const noise = await check('noise', 300)
    expect(noise.outcome).toBe('unknown')
    const refused = await check('refuse')
    expect(refused).toEqual({
      serverName: 'acme',
      outcome: 'unknown',
      detail: 'Unknown command: /mcp',
    })
  })

  it('never answers an extension input request', async () => {
    // Answering would win the race against the adapter's own loopback callback
    // and abort an OAuth flow that had already succeeded — the same trap
    // connector-auth.ts guards. The fake reports "answered" if we reply.
    const result = await check('prompt', 400)
    expect(result).toEqual({
      serverName: 'acme',
      outcome: 'unknown',
      detail: 'The adapter did not answer in time.',
    })
  })
})
