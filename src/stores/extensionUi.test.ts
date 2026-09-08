// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useExtensionUiStore } from './extensionUi'
import { useConnectorsStore } from './connectors'

const invoke = vi.fn(async (..._args: unknown[]) => undefined)

beforeEach(() => {
  invoke.mockClear()
  useExtensionUiStore.setState({ dialogs: [], statuses: {}, widgets: {}, toasts: [] })
  useConnectorsStore.setState({ flows: {} })
  // @ts-expect-error partial preload surface
  window.phosphor = { invoke }
})

const oauthRequest = {
  type: 'extension_ui_request' as const,
  id: 'req-1',
  method: 'input' as const,
  title:
    'Complete linear OAuth\n\nhttps://linear.app/oauth/authorize?state=1\n\n' +
    'Approve access, then paste the full localhost callback URL below.',
}

describe('extension UI requests', () => {
  it('routes the adapter OAuth prompt to the connector flow, not to a dialog', () => {
    useExtensionUiStore.getState().handleRequest('s1', oauthRequest)
    expect(useExtensionUiStore.getState().dialogs).toEqual([])
    expect(useConnectorsStore.getState().flows.linear).toMatchObject({
      phase: 'awaiting-browser',
      requestId: 'req-1',
    })
    expect(invoke).toHaveBeenCalledWith(
      'app:openExternal',
      'https://linear.app/oauth/authorize?state=1',
    )
  })

  it('leaves every other input prompt as an ordinary dialog', () => {
    useExtensionUiStore.getState().handleRequest('s1', {
      type: 'extension_ui_request',
      id: 'req-2',
      method: 'input',
      title: 'Commit message?',
    })
    expect(useExtensionUiStore.getState().dialogs).toHaveLength(1)
  })

  it('settles a flow on the adapter notification, and still shows the toast', () => {
    useExtensionUiStore.getState().handleRequest('s1', oauthRequest)
    useExtensionUiStore.getState().handleRequest('s1', {
      type: 'extension_ui_request',
      id: 'req-3',
      method: 'notify',
      message: 'OAuth authentication successful for "linear".',
    })
    expect(useConnectorsStore.getState().flows.linear).toEqual({ phase: 'connected' })
    expect(useExtensionUiStore.getState().toasts).toHaveLength(1)
  })
})
