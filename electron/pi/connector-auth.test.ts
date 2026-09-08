import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ConnectorAuthState } from '@shared/models'
import {
  cancelConnectorAuth,
  hasConnectorAuthRun,
  startConnectorAuth,
  submitConnectorCallback,
} from './connector-auth'

const here = dirname(fileURLToPath(import.meta.url))
const fakePi = join(here, '__fixtures__', 'fake-mcp-auth-pi.cjs')

vi.mock('../debug-log', () => ({ log: () => {} }))

function run(
  serverName: string,
  mode: string,
  overrides: { timeoutMs?: number } = {},
): { states: ConnectorAuthState[]; opened: string[]; done: Promise<void> } {
  const states: ConnectorAuthState[] = []
  const opened: string[] = []
  const done = startConnectorAuth({
    serverName,
    cwd: here,
    binaryPath: process.execPath,
    prefixArgs: [fakePi],
    env: { PHOSPHOR_FAKE_AUTH: mode },
    onState: (state) => states.push(state),
    openUrl: (url) => opened.push(url),
    ...overrides,
  })
  return { states, opened, done }
}

afterEach(async () => {
  await cancelConnectorAuth('acme')
})

describe('headless connector authorization', () => {
  it('drives /mcp-auth in a throwaway pi and opens the authorization page', async () => {
    const { states, opened, done } = run('acme', 'callback')
    await done
    expect(opened).toEqual(['https://provider.test/oauth/authorize?client_id=abc&state=xyz'])
    expect(states.map((s) => s.phase)).toEqual(['starting', 'awaiting-browser', 'connected'])
    // Every run is reclaimed: a leaked pi process would sit on the OAuth
    // callback port and break the next attempt.
    expect(hasConnectorAuthRun('acme')).toBe(false)
  })

  it('never answers the adapter prompt on its own', async () => {
    // `manual` only succeeds if the client replies to the prompt. Nothing here
    // replies, so the flow must NOT settle — which is the whole point: an
    // auto-answer would win the race against the loopback callback and abort a
    // flow that had already succeeded.
    const { states, done } = run('acme', 'manual', { timeoutMs: 250 })
    await done
    expect(states.map((s) => s.phase)).toEqual(['starting', 'awaiting-browser', 'failed'])
    expect(states.at(-1)).toEqual({ phase: 'failed', message: 'Authorization timed out.' })
  })

  it('completes from a pasted callback URL when the loopback never fires', async () => {
    const { states, done } = run('acme', 'manual', { timeoutMs: 5000 })
    await vi.waitFor(() => expect(states.at(-1)?.phase).toBe('awaiting-browser'))
    expect(
      submitConnectorCallback('acme', ' http://localhost:19876/callback?code=1&state=xyz '),
    ).toBe(true)
    await done
    expect(states.at(-1)).toEqual({ phase: 'connected' })
  })

  it('reports the adapter own failure text', async () => {
    const { states, done } = run('acme', 'fail')
    await done
    expect(states.at(-1)).toEqual({ phase: 'failed', message: 'redirect_uri mismatch' })
  })

  it('reports a refused command instead of hanging', async () => {
    const { states, done } = run('acme', 'refuse')
    await done
    expect(states.at(-1)).toMatchObject({ phase: 'failed' })
    expect((states.at(-1) as { message: string }).message).toMatch(/Unknown command/)
  })

  it('ignores a pasted URL when nothing is waiting for one', () => {
    expect(submitConnectorCallback('nothing-running', 'http://localhost/cb')).toBe(false)
  })

  it('cancelling kills the process and forgets the run', async () => {
    const { done } = run('acme', 'silent', { timeoutMs: 5000 })
    await vi.waitFor(() => expect(hasConnectorAuthRun('acme')).toBe(true))
    await cancelConnectorAuth('acme')
    expect(hasConnectorAuthRun('acme')).toBe(false)
    await done
  })
})
