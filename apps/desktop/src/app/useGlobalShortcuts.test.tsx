// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openFindForFocus } from '@/components/search/findTargets'
import { useGlobalShortcuts } from './useGlobalShortcuts'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useFinderStore } from '@/features/files/FuzzyFinder'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { useSettingsStore } from '@/stores/settings'
import { useChatUiStore } from '@/features/chat/uiState'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useWorkspaceSearchStore } from '@/features/files/workspaceSearchStore'
import { mockRemoteInfo } from '@/dev/mockRemoteLanes'

let root: Root
let host: HTMLDivElement
const invoke = vi.fn().mockResolvedValue(undefined)
function Shortcuts(): null {
  useGlobalShortcuts()
  return null
}
function key(code: string, shiftKey = false, ctrlKey = false): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        code,
        shiftKey,
        ctrlKey,
        metaKey: !ctrlKey,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.assign(window, { phosphor: { invoke } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<Shortcuts />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
for (const remote of [false, true]) {
  it(`routes the shortcut table on ${remote ? 'Host' : 'This Mac'} without local file IPC`, () => {
    const id = mockRemoteInfo.sessionId
    useSessionsStore.setState({
      activeSessionId: id,
      live: {
        [id]: {
          ...mockRemoteInfo,
          phosphorId: id,
          workspacePath: remote ? mockRemoteInfo.workspacePath : '/mac',
          target: remote ? mockRemoteInfo.target : { kind: 'local' },
        },
      },
    })
    const pane = vi.spyOn(useLayoutStore.getState(), 'toggleRightPane').mockImplementation(() => {})
    const sidebar = vi
      .spyOn(useLayoutStore.getState(), 'toggleSidebar')
      .mockImplementation(() => {})
    const finder = vi.spyOn(useFinderStore.getState(), 'setOpen').mockImplementation(() => {})
    const settings = vi.spyOn(useSettingsUiStore.getState(), 'setOpen').mockImplementation(() => {})
    const tab = vi.spyOn(useSettingsUiStore.getState(), 'setTab').mockImplementation(() => {})
    const scale = vi.spyOn(useSettingsStore.getState(), 'setFonts').mockImplementation(() => {})
    const verbose = vi
      .spyOn(useChatUiStore.getState(), 'toggleVerbose')
      .mockImplementation(() => {})
    const activate = vi.spyOn(useSessionsStore.getState(), 'activate').mockImplementation(() => {})
    invoke.mockClear()
    key('Backquote')
    key('KeyE', true)
    key('KeyG', true)
    expect(pane.mock.calls).toEqual([['terminal'], ['files'], ['changes']])
    key('KeyB')
    expect(sidebar).toHaveBeenCalledOnce()
    key('KeyP')
    expect(finder).toHaveBeenCalledWith(true)
    key('Comma')
    key('Slash')
    expect(settings).toHaveBeenCalledTimes(2)
    expect(tab).toHaveBeenCalledWith('keybindings')
    key('Equal')
    expect(scale).toHaveBeenCalled()
    key('KeyO', false, true)
    expect(verbose).toHaveBeenCalledWith(id)
    key('KeyF')
    expect(openFindForFocus).toHaveBeenCalledOnce()
    key('KeyN')
    expect(activate).toHaveBeenCalledWith(null)
    const input = document.createElement('textarea')
    input.setAttribute('data-composer-input', '')
    host.append(input)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F6', bubbles: true }))
    })
    expect(document.activeElement).toBe(input)
    expect(invoke).not.toHaveBeenCalled()
  })
  it(`workspace search ${remote ? 'refuses Host' : 'opens locally'}`, () => {
    const id = mockRemoteInfo.sessionId
    useSessionsStore.setState({
      activeSessionId: id,
      live: {
        [id]: {
          ...mockRemoteInfo,
          phosphorId: id,
          workspacePath: remote ? mockRemoteInfo.workspacePath : '/mac',
          target: remote ? mockRemoteInfo.target : { kind: 'local' },
        },
      },
    })
    useWorkspacesStore.setState({ homePath: '/must-not-search' })
    const search = vi
      .spyOn(useWorkspaceSearchStore.getState(), 'openSearch')
      .mockImplementation(() => {})
    const toast = vi.spyOn(useExtensionUiStore.getState(), 'pushToast').mockImplementation(() => 1)
    const pane = vi.spyOn(useLayoutStore.getState(), 'setRightPane')
    invoke.mockClear()
    key('KeyF', true)
    expect(pane).toHaveBeenCalledWith('files')
    if (remote) {
      expect(search).not.toHaveBeenCalled()
      expect(toast).toHaveBeenCalledWith('Not available on remote lanes yet.')
    } else expect(search).toHaveBeenCalledWith('/mac', undefined)
    expect(invoke).not.toHaveBeenCalled()
  })
}

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: vi.fn() }))

vi.mock('@/components/search/findTargets', () => ({
  openFindForFocus: vi.fn().mockReturnValue(true),
}))
