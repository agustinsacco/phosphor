// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnectorsStore } from './connectors'

const invoke = vi.fn(async (..._args: unknown[]) => undefined)
const piCommand = vi.fn(async () => ({ success: true, data: undefined }))

beforeEach(() => {
  invoke.mockClear()
  piCommand.mockClear()
  useConnectorsStore.setState({ flows: {} })
  // @ts-expect-error partial preload surface, only what the store touches
  window.phosphor = { invoke, piCommand }
})

const calls = (channel: string): unknown[][] =>
  invoke.mock.calls.filter((call) => call[0] === channel).map((call) => call.slice(1))

describe('connector flow — headless (no session)', () => {
  it('authorizes through main, which spawns its own throwaway pi', async () => {
    await useConnectorsStore.getState().connect('linear')
    expect(calls('mcp:authorize')).toEqual([['linear']])
    expect(piCommand).not.toHaveBeenCalled()
    expect(useConnectorsStore.getState().flows.linear).toEqual({ phase: 'starting' })
  })

  it('renders the phases main pushes, dropping nothing', () => {
    const store = useConnectorsStore.getState()
    store.headlessState('linear', {
      phase: 'awaiting-browser',
      authorizationUrl: 'https://provider.test/a',
    })
    expect(useConnectorsStore.getState().flows.linear).toEqual({
      phase: 'awaiting-browser',
      authorizationUrl: 'https://provider.test/a',
    })
    store.headlessState('linear', { phase: 'connected' })
    expect(useConnectorsStore.getState().flows.linear).toEqual({ phase: 'connected' })
  })

  it('routes a pasted callback URL to main, not to a session', () => {
    const store = useConnectorsStore.getState()
    store.headlessState('linear', {
      phase: 'awaiting-browser',
      authorizationUrl: 'https://provider.test/a',
    })
    store.submitCallbackUrl('linear', '  http://localhost:19876/callback?code=1 ')
    expect(calls('mcp:submitAuthCallback')).toEqual([
      ['linear', 'http://localhost:19876/callback?code=1'],
    ])
    expect(calls('pi:extensionUiResponse')).toEqual([])
  })

  it('cancels the main-process run', () => {
    const store = useConnectorsStore.getState()
    store.headlessState('linear', {
      phase: 'awaiting-browser',
      authorizationUrl: 'https://provider.test/a',
    })
    store.cancel('linear')
    expect(calls('mcp:cancelAuth')).toEqual([['linear']])
    expect(useConnectorsStore.getState().flows.linear).toBeUndefined()
  })
})

describe('connector flow — in a live session', () => {
  it('signs in with the adapter command, which runs no model', async () => {
    await useConnectorsStore.getState().connect('linear', 's1')
    expect(piCommand).toHaveBeenCalledWith('s1', { type: 'prompt', message: '/mcp-auth linear' })
    expect(calls('mcp:authorize')).toEqual([])
    expect(useConnectorsStore.getState().flows.linear).toEqual({
      phase: 'starting',
      sessionId: 's1',
    })
  })

  it('opens the browser and NEVER answers the adapter prompt on its own', () => {
    useConnectorsStore.getState().promptReceived({
      sessionId: 's1',
      serverName: 'linear',
      authorizationUrl: 'https://linear.app/oauth/authorize',
      requestId: 'req-1',
    })
    expect(calls('app:openExternal')).toEqual([['https://linear.app/oauth/authorize']])
    // The load-bearing rule: pi's RPC has no cancel, and an empty answer wins
    // the race against the loopback callback and kills a successful flow.
    expect(calls('pi:extensionUiResponse')).toEqual([])
    expect(useConnectorsStore.getState().flows.linear).toMatchObject({
      phase: 'awaiting-browser',
      requestId: 'req-1',
    })
  })

  it('settles on the adapter verdict, keeping its message on failure', () => {
    useConnectorsStore.getState().settle('linear', 'success')
    expect(useConnectorsStore.getState().flows.linear).toEqual({ phase: 'connected' })
    useConnectorsStore.getState().settle('slack', 'failure', 'redirect_uri mismatch')
    expect(useConnectorsStore.getState().flows.slack).toEqual({
      phase: 'failed',
      message: 'redirect_uri mismatch',
    })
  })

  it('answers the session’s pending prompt when the user pastes a callback URL', () => {
    const store = useConnectorsStore.getState()
    store.promptReceived({
      sessionId: 's1',
      serverName: 'linear',
      authorizationUrl: 'https://linear.app/oauth/authorize',
      requestId: 'req-1',
    })
    store.submitCallbackUrl('linear', 'http://localhost:19876/cb?code=1')
    expect(calls('pi:extensionUiResponse')).toEqual([
      [
        's1',
        { type: 'extension_ui_response', id: 'req-1', value: 'http://localhost:19876/cb?code=1' },
      ],
    ])
    expect(calls('mcp:submitAuthCallback')).toEqual([])
  })

  it('ignores a paste when no prompt is pending', () => {
    useConnectorsStore.getState().submitCallbackUrl('linear', 'http://localhost:19876/cb')
    expect(calls('pi:extensionUiResponse')).toEqual([])
    expect(calls('mcp:submitAuthCallback')).toEqual([])
  })

  it('cancels explicitly — the only case where Phosphor answers', () => {
    const store = useConnectorsStore.getState()
    store.promptReceived({
      sessionId: 's1',
      serverName: 'linear',
      authorizationUrl: 'https://linear.app/oauth/authorize',
      requestId: 'req-1',
    })
    store.cancel('linear')
    expect(calls('pi:extensionUiResponse')).toEqual([
      ['s1', { type: 'extension_ui_response', id: 'req-1', cancelled: true }],
    ])
    expect(useConnectorsStore.getState().flows.linear).toBeUndefined()
  })

  it('disconnects through the adapter so it clears its own stored credentials', async () => {
    await useConnectorsStore.getState().disconnect('slack', 's1')
    expect(piCommand).toHaveBeenCalledWith('s1', { type: 'prompt', message: '/mcp logout slack' })
  })

  it('disconnecting with no session removes config without pretending to log out', async () => {
    await useConnectorsStore.getState().disconnect('slack')
    expect(piCommand).not.toHaveBeenCalled()
  })
})
