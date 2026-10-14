// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { useExtensionUiStore } from './extensionUi'

beforeEach(() => {
  useExtensionUiStore.setState({ dialogs: [], statuses: {}, widgets: {}, toasts: [] })
})

describe('extension UI requests', () => {
  it('shows an input prompt as an ordinary dialog — pi’s own /mcp sign-in included', () => {
    useExtensionUiStore.getState().handleRequest('s1', {
      type: 'extension_ui_request',
      id: 'req-1',
      method: 'input',
      title: 'Commit message?',
    })
    expect(useExtensionUiStore.getState().dialogs).toHaveLength(1)
  })

  it('shows a notification as a toast', () => {
    useExtensionUiStore.getState().handleRequest('s1', {
      type: 'extension_ui_request',
      id: 'req-2',
      method: 'notify',
      message: 'MCP servers need attention:\n  linear: needs sign-in\nRun /mcp to fix.',
      notifyType: 'warning',
    })
    expect(useExtensionUiStore.getState().toasts).toHaveLength(1)
    expect(useExtensionUiStore.getState().dialogs).toEqual([])
  })
})
