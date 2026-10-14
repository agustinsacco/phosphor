// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteFilesPane } from './RemoteFilesPane'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo, mockRemoteHosts } from '@/dev/mockRemoteLanes'
import type { SessionPush } from '@shared/models'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoEditor: ({
    value,
    onChange,
    onSave,
    readOnly,
  }: {
    value: string
    onChange(value: string): void
    onSave(): void
    readOnly: boolean
  }) => (
    <div>
      <textarea value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />
      <button onClick={() => onChange('edited')}>Edit</button>
      <button onClick={onSave}>Editor save</button>
    </div>
  ),
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
    connectionToken: 'test-connection-1',
    state: 'ready' as const,
    capabilities: ['sessions.read', 'workspaces.read'] as const,
    repositories: [],
    lanes: mockRemoteHosts[hostId]?.lanes ?? [],
  }
  useRemoteLanesStore.setState({
    hosts: { [hostId]: { ...host, capabilities: [...host.capabilities] } },
  })
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
  let listener: ((push: SessionPush) => void) | undefined
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
    const listCount = () =>
      invoke.mock.calls.filter(([channel]) => channel === 'fs:listFiles').length
    const count = listCount()
    // Stream-driven Host object replacement and other lanes do not reload Files.
    for (let i = 0; i < 10; i++) {
      await act(async () =>
        listener?.({
          kind: 'event',
          event: {
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'text' },
          },
        }),
      )
      await act(async () =>
        useRemoteLanesStore.setState({
          hosts: { [hostId]: { ...host, capabilities: [...host.capabilities] } },
        }),
      )
    }
    expect(listCount()).toBe(count)
    // The Host publishes a new summary when a turn ends.
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
    await act(async () =>
      useRemoteLanesStore.setState({
        hosts: {
          [hostId]: {
            ...host,
            capabilities: [...host.capabilities],
            lanes: host.lanes.map((lane) => ({ ...lane, updatedAt: new Date(1000).toISOString() })),
          },
        },
      }),
    )
    expect(listCount()).toBe(count + 1)
    await act(async () =>
      useRemoteLanesStore.setState({
        hosts: {
          [hostId]: {
            ...host,
            capabilities: [...host.capabilities],
            lanes: host.lanes.map((lane) => ({ ...lane, updatedAt: new Date(1000).toISOString() })),
            cursor: { epoch: 'new-runtime', seq: 1 },
          },
        },
      }),
    )
    expect(listCount()).toBe(count + 2)
    await act(async () => container.querySelector('button')?.click())
    expect(listCount()).toBe(count + 3)
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

it.each(['??', 'A ', 'AM', ' M'])(
  'keeps current content for %s when HEAD is absent',
  async (status) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const target = mockRemoteInfo.target
    if (target?.kind !== 'remote') throw new Error('Missing remote fixture')
    const sessionId = mockRemoteInfo.sessionId
    useSessionsStore.setState({
      live: { [sessionId]: { phosphorId: sessionId, ...mockRemoteInfo } },
    })
    useRemoteLanesStore.setState({
      hosts: {
        [target.hostId]: {
          connectionToken: 'test-connection-1',
          state: 'ready',
          capabilities: ['workspaces.read'],
          repositories: [],
          lanes: [],
        },
      },
    })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'fs:listFiles') return ['new.ts']
      if (channel === 'git:statusMap') return { 'new.ts': status }
      if (channel === 'fs:readFile') return { content: 'current content', binary: false }
      if (channel === 'git:showFileAt') throw new Error('Not available on remote lanes yet.')
      throw new Error('Unexpected channel')
    })
    vi.stubGlobal('phosphor', { invoke })
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () =>
        root.render(
          <RemoteFilesPane
            workspacePath={mockRemoteInfo.workspacePath}
            sessionId={sessionId}
            changes
          />,
        ),
      )
      const file = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('new.ts'),
      )
      await act(async () => file?.click())
      expect(container.textContent).toContain('current content')
      const headCalls = invoke.mock.calls.filter(([channel]) => channel === 'git:showFileAt')
      expect(headCalls).toHaveLength(status === ' M' ? 1 : 0)
      expect(container.textContent?.includes('The HEAD version could not be read.')).toBe(
        status === ' M',
      )
      expect(container.textContent).not.toContain('Not available on remote lanes yet.')
    } finally {
      act(() => root.unmount())
    }
  },
)

it.each(['success', 'conflict', 'unknown'])(
  'keeps revision-safe edits on %s saves',
  async (outcome) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const target = mockRemoteInfo.target
    if (target?.kind !== 'remote') throw new Error('Missing remote fixture')
    const sessionId = mockRemoteInfo.sessionId
    useSessionsStore.setState({
      live: { [sessionId]: { phosphorId: sessionId, ...mockRemoteInfo } },
    })
    const fixture = mockRemoteHosts[target.hostId]
    if (!fixture) throw new Error('Missing Host fixture')
    useRemoteLanesStore.setState({
      hosts: {
        [target.hostId]: {
          ...fixture,
          connectionToken: 'test-connection-1',
          state: 'ready',
          capabilities: [
            'sessions.read',
            'sessions.control',
            'workspaces.read',
            'workspaces.write',
          ],
          lanes: fixture.lanes.map((lane) => ({
            ...lane,
            control: {
              ...lane.control,
              controller: { self: true, label: 'Desktop', connected: true },
            },
          })),
        },
      },
    })
    const revision = 'a'.repeat(64)
    const invoke = vi.fn(async (channel: string, ..._args: unknown[]) => {
      if (channel === 'fs:listFiles') return ['a.ts']
      if (channel === 'git:statusMap') return {}
      if (channel === 'fs:readFile') return { content: 'original', binary: false, revision }
      if (channel === 'fs:writeFile') {
        if (outcome !== 'success')
          throw new Error(outcome === 'conflict' ? 'changed-on-disk' : 'unknown')
        return { revision: 'b'.repeat(64), mtimeMs: 1 }
      }
      throw new Error('Unexpected channel')
    })
    vi.stubGlobal('phosphor', { invoke })
    const container = document.createElement('div')
    const root = createRoot(container)
    async function click(label: string) {
      const button = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
      if (!button) throw new Error(`Missing button ${label}`)
      await act(async () => button.click())
    }
    try {
      await act(async () =>
        root.render(
          <RemoteFilesPane
            workspacePath={mockRemoteInfo.workspacePath}
            sessionId={sessionId}
            changes={false}
          />,
        ),
      )
      await click(' a.ts')
      await click('Edit')
      await click('Editor save')
      expect(invoke).toHaveBeenCalledWith(
        'fs:writeFile',
        `${mockRemoteInfo.workspacePath}/a.ts`,
        'edited',
        revision,
      )
      expect(container.querySelector('textarea')?.value).toBe('edited')
      expect(
        container.textContent?.includes(outcome === 'unknown' ? 'Reload file' : 'Discard edits'),
      ).toBe(outcome !== 'success')
      if (outcome === 'conflict') expect(container.textContent).toContain('File changed on disk')
      if (outcome === 'unknown') {
        expect(container.textContent).toContain('Do not retry an uncertain save')
        const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')
        expect(save?.disabled).toBe(true)
        await click('Save')
        await click('Editor save')
        expect(invoke.mock.calls.filter(([channel]) => channel === 'fs:writeFile')).toHaveLength(1)
        expect(container.querySelector('textarea')?.value).toBe('edited')
        await click('Reload file')
        expect(container.querySelector('textarea')?.value).toBe('original')
        await click('Edit')
        await click('Editor save')
        expect(invoke.mock.calls.filter(([channel]) => channel === 'fs:writeFile')).toHaveLength(2)
      }
      expect(invoke.mock.calls.filter(([channel]) => channel === 'fs:writeFile')).toHaveLength(
        outcome === 'unknown' ? 2 : 1,
      )
    } finally {
      act(() => root.unmount())
    }
  },
)
