// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CommandPalette, usePaletteStore } from './CommandPalette'
import type { SessionMeta } from '@shared/models'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo, mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

it('Cmd+K works on Host, filters local actions and refreshes Mac → Host → Mac entries', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  const invoke = vi.fn().mockRejectedValue(new Error('No local IPC allowed'))
  Object.assign(window, { phosphor: { invoke } })
  const host = document.createElement('div'),
    root = createRoot(host)
  document.body.append(host)
  const id = mockRemoteInfo.sessionId
  const remote = { ...mockRemoteInfo, phosphorId: id }
  const disk: SessionMeta = {
    path: '/mac/session.jsonl',
    sessionId: 'mac-disk',
    cwd: '/mac',
    createdAt: '',
    name: 'Mac disk lane',
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    headroomSavedTokens: 0,
    entryCount: 0,
    branchCount: 0,
    mtimeMs: 0,
    lastActivityAt: '',
  }
  useWorkspacesStore.setState({
    recents: [{ path: '/other-mac', name: 'Mac only', lastOpenedAt: 0 }],
  })
  useSessionsStore.setState({
    activeSessionId: id,
    live: { [id]: remote },
    disk: { '/mac': [disk], [remote.workspacePath]: [disk] },
  })
  useRemoteLanesStore.setState({ hosts: mockRemoteHosts })
  usePaletteStore.setState({ open: false })
  const query = async (value: string) => {
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Type a command…"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  try {
    await act(async () => {
      useSessionsStore.setState({
        live: { [id]: { ...remote, workspacePath: '/mac', target: { kind: 'local' } } },
      })
      root.render(<CommandPalette workspacePath="/mac" />)
    })
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyK', metaKey: true, bubbles: true }),
      )
    })
    expect(usePaletteStore.getState().open).toBe(true)
    await query('Open workspace folder')
    expect(document.body.textContent).toContain('Open workspace folder…')
    await act(async () => {
      useSessionsStore.setState({ live: { [id]: remote } })
      root.render(<CommandPalette workspacePath={mockRemoteInfo.workspacePath} />)
    })
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyK', metaKey: true, bubbles: true }),
      )
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyK', metaKey: true, bubbles: true }),
      )
    })
    expect(usePaletteStore.getState().open).toBe(true)
    for (const label of [
      'Open workspace folder',
      'Switch workspace',
      'Open session:',
      'Rewind',
      'Open skills page',
      'Open artifacts page',
    ]) {
      await query(label)
      expect(document.body.textContent).toContain('No matching commands')
    }
    for (const label of [
      'Go to file',
      'Toggle terminal',
      'Toggle files',
      'Toggle changes',
      'New session',
    ]) {
      await query(label)
      expect(document.body.textContent).toContain(label)
      expect(document.body.textContent).not.toContain('No matching commands')
    }
    const lane = mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!
    await query('Open lane:')
    expect(document.body.textContent).toContain(lane.title ?? 'Untitled lane')
    // A live snapshot update must replace the visible lane title, even with the palette open.
    await act(async () =>
      useRemoteLanesStore.setState({
        hosts: {
          ...mockRemoteHosts,
          [MOCK_HOST_ID]: {
            ...mockRemoteHosts[MOCK_HOST_ID]!,
            lanes: [{ ...lane, title: 'Fresh Host title' }],
          },
        },
      }),
    )
    expect(document.body.textContent).toContain('Fresh Host title')
    await act(async () => {
      useSessionsStore.setState({
        live: { [id]: { ...remote, workspacePath: '/mac', target: { kind: 'local' } } },
      })
      root.render(<CommandPalette workspacePath="/mac" />)
    })
    await query('Open lane:')
    expect(document.body.textContent).toContain('No matching commands')
    await query('Open workspace folder')
    expect(document.body.textContent).toContain('Open workspace folder…')
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    host.remove()
    usePaletteStore.setState({ open: false })
    vi.unstubAllGlobals()
  }
})

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: vi.fn() }))
