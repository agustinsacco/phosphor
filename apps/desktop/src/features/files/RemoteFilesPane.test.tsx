// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteFilesPane } from './RemoteFilesPane'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo } from '@/dev/mockRemoteLanes'
import type { SessionPush } from '@shared/models'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./MonacoEditor', () => ({
  MonacoDiff: ({ originalText, modifiedText }: { originalText: string; modifiedText: string }) => (
    <div>
      Diff: {originalText} {modifiedText}
    </div>
  ),
}))
afterEach(() => {
  vi.unstubAllGlobals()
  useRemoteLanesStore.setState({ hosts: {} })
})
it('shows read-only files and diffs, refreshes on turn end and summary, never watches or writes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const hostId = mockRemoteInfo.target?.kind === 'remote' ? mockRemoteInfo.target.hostId : ''
  const sessionId = mockRemoteInfo.sessionId
  useSessionsStore.setState({ live: { [sessionId]: { phosphorId: sessionId, ...mockRemoteInfo } } })
  const host = {
    state: 'ready' as const,
    capabilities: ['sessions.read', 'workspaces.read'] as const,
    repositories: [],
    lanes: [],
  }
  useRemoteLanesStore.setState({
    hosts: { [hostId]: { ...host, capabilities: [...host.capabilities] } },
  })
  let listener: ((push: SessionPush) => void) | undefined
  const invoke = vi.fn(async (channel: string) => {
    switch (channel) {
      case 'fs:listFiles':
        return ['a.ts']
      case 'git:statusMap':
        return { 'a.ts': ' M' }
      case 'fs:readFile':
        return { content: 'new text', binary: false, size: 8, mtimeMs: 0 }
      case 'git:showFileAt':
        return 'old text'
      default:
        throw new Error(`Unexpected channel ${channel}`)
    }
  })
  vi.stubGlobal('phosphor', {
    invoke,
    onSessionPush: (_: string, cb: (push: SessionPush) => void) => {
      listener = cb
      return () => {}
    },
  })
  const container = document.createElement('div')
  const root = createRoot(container)
  const render = async (changes = false) => {
    await act(async () => {
      root.render(
        <RemoteFilesPane
          workspacePath={mockRemoteInfo.workspacePath}
          sessionId={sessionId}
          changes={changes}
        />,
      )
    })
  }
  try {
    await render()
    expect(container.textContent).toContain('Read-only')
    expect(container.textContent).toContain('a.ts')
    const file = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('a.ts'),
    )
    await act(async () => file?.click())
    expect(container.textContent).toContain('new text')
    await render(true)
    expect(container.textContent).toContain('Diff: old text new text')
    const count = invoke.mock.calls.length
    await act(async () =>
      listener?.({
        kind: 'event',
        event: {
          type: 'turn_end',
          message: { role: 'user', content: 'test', timestamp: 0 },
          toolResults: [],
        },
      }),
    )
    expect(invoke.mock.calls.length).toBeGreaterThan(count)
    const afterTurn = invoke.mock.calls.length
    await act(async () =>
      useRemoteLanesStore.setState({
        hosts: { [hostId]: { ...host, capabilities: [...host.capabilities] } },
      }),
    )
    expect(invoke.mock.calls.length).toBeGreaterThan(afterTurn)
    await act(async () => container.querySelector('button')?.click())
    expect(
      invoke.mock.calls.every(([channel]) =>
        ['fs:listFiles', 'git:statusMap', 'fs:readFile', 'git:showFileAt'].includes(channel),
      ),
    ).toBe(true)
    await act(async () =>
      useRemoteLanesStore.setState({
        hosts: { [hostId]: { ...host, capabilities: ['sessions.read'] } },
      }),
    )
    expect(container.textContent).toContain('Not available on remote lanes yet.')
  } finally {
    act(() => root.unmount())
  }
})
