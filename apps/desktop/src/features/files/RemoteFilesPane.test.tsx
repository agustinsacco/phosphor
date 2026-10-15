// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteFilesPane } from './RemoteFilesPane'
import { RightPane } from './RightPane'
import { useLayoutStore } from '@/stores/layout'
import { useSessionsStore, forgetRemoteSession } from '@/stores/sessions'
import { useRemoteFileDrafts } from './remoteFileDrafts'
import { useRemoteFileSelection, openRemoteFile } from './remoteFileSelection'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo, mockRemoteHosts } from '@/dev/mockRemoteLanes'
import type { SessionPush } from '@shared/models'

vi.mock('./FilesPane', () => ({ FilesPane: () => null }))
vi.mock('./FilesChangedPane', () => ({ FilesChangedPane: () => null }))
vi.mock('@/features/terminal/TerminalPane', () => ({ TerminalPane: () => null }))
vi.mock('@/features/artifacts/ArtifactsPane', () => ({ ArtifactsPane: () => null }))
vi.mock('@/features/artifacts/RemoteArtifactsPane', () => ({ RemoteArtifactsPane: () => null }))
vi.mock('@/features/chat/SubagentPanel', () => ({ SubagentPanel: () => null }))
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
  useRemoteFileDrafts.setState({ bySession: {} })
  useRemoteFileSelection.setState({ bySession: {}, blocked: {} })
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
  'keeps revision-safe edits through disconnect/reconnect on %s saves',
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
    useLayoutStore.setState({
      bySession: { [sessionId]: { pane: 'files', expanded: false, side: 'right', size: 45 } },
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
      const button = [...container.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === label.trim() || b.getAttribute('aria-label') === label,
      )
      if (!button) throw new Error(`Missing button ${label}`)
      await act(async () => button.click())
    }
    try {
      await act(async () =>
        root.render(
          <RightPane workspacePath={mockRemoteInfo.workspacePath} sessionId={sessionId} />,
        ),
      )
      await click(' a.ts')
      await click('Edit')
      const editor = container.querySelector('textarea')
      const host = useRemoteLanesStore.getState().hosts[target.hostId]
      if (!host) throw new Error('Host missing')
      const reads = invoke.mock.calls.filter(([c]) => c === 'fs:readFile').length
      await act(async () =>
        useRemoteLanesStore.setState({
          hosts: { [target.hostId]: { ...host, state: 'reconnecting' } },
        }),
      )
      expect(container.querySelector('textarea')).toBe(editor)
      expect(editor?.value).toBe('edited')
      expect(editor?.readOnly).toBe(true)
      expect(container.textContent).toContain('Reconnecting')
      await click('Editor save')
      expect(invoke.mock.calls.filter(([c]) => c === 'fs:writeFile')).toHaveLength(0)
      await act(async () => useRemoteLanesStore.setState({ hosts: { [target.hostId]: host } }))
      expect(container.querySelector('textarea')).toBe(editor)
      expect(editor?.value).toBe('edited')
      expect(invoke.mock.calls.filter(([c]) => c === 'fs:readFile')).toHaveLength(reads)
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
        const save = [...container.querySelectorAll('button')].find(
          (b) => b.getAttribute('aria-label') === 'Save',
        )
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

it.each([
  'save',
  'discard',
  'forget',
  'conflict',
  'unknown',
  'pending-success',
  'pending-success-unmounted',
  'pending-conflict',
  'pending-unknown',
  'pending-forget',
])(
  'restores only the dirty lane and its original revision across A → B → A (%s)',
  async (outcome) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const target = mockRemoteInfo.target
    if (target?.kind !== 'remote') throw new Error('Missing remote fixture')
    const a = mockRemoteInfo.sessionId
    const b = `${a}-other`
    const fixture = mockRemoteHosts[target.hostId]!
    const lane = fixture.lanes.find((l) => l.laneId === mockRemoteInfo.laneId)!
    useSessionsStore.setState({
      live: {
        [a]: { phosphorId: a, ...mockRemoteInfo },
        [b]: { ...mockRemoteInfo, phosphorId: b, sessionId: b, laneId: 'other-lane' },
      },
    })
    useRemoteLanesStore.setState({
      hosts: {
        [target.hostId]: {
          ...fixture,
          state: 'ready',
          capabilities: [
            'sessions.read',
            'sessions.control',
            'workspaces.read',
            'workspaces.write',
          ],
          lanes: [lane, { ...lane, laneId: 'other-lane' }].map((l) => ({
            ...l,
            control: {
              ...l.control,
              controller: { self: true, label: 'Desktop', connected: true },
            },
          })),
        },
      },
    })
    const originalRevision = 'a'.repeat(64)
    let hostContent = 'original'
    let hostRevision = originalRevision
    let settlePending: (() => void) | undefined
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'fs:listFiles') return ['remote.txt', 'other.txt']
      if (channel === 'git:statusMap') return {}
      if (channel === 'fs:readFile')
        return { content: hostContent, binary: false, revision: hostRevision }
      if (channel === 'fs:writeFile') {
        if (outcome.startsWith('pending-'))
          return new Promise<{ revision: string; mtimeMs: number }>((resolve, reject) => {
            settlePending = () => {
              if (outcome.startsWith('pending-success')) {
                hostContent = String(args[1])
                resolve({ revision: 'c'.repeat(64), mtimeMs: 1 })
              } else
                reject(new Error(outcome === 'pending-unknown' ? 'unknown' : 'changed-on-disk'))
            }
          })
        if (outcome === 'unknown') throw new Error('unknown')
        if (args[2] !== hostRevision) throw new Error('changed-on-disk')
        hostContent = String(args[1])
        return { revision: 'c'.repeat(64), mtimeMs: 1 }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    vi.stubGlobal('phosphor', { invoke })
    const container = document.createElement('div')
    const root = createRoot(container)
    const render = async (id: string) => {
      await act(async () =>
        root.render(
          <RemoteFilesPane
            workspacePath={mockRemoteInfo.workspacePath}
            sessionId={id}
            changes={false}
          />,
        ),
      )
    }
    const button = (label: string) => {
      const result = [...container.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
      )
      if (!result) throw new Error(`Missing button ${label}`)
      return result
    }
    const click = async (label: string) => {
      await act(async () => button(label).click())
    }
    try {
      await render(a)
      await click('remote.txt')
      await click('Edit')
      expect(useRemoteFileDrafts.getState().bySession[a]).toMatchObject({
        selected: 'remote.txt',
        content: 'edited',
        before: '',
        revision: originalRevision,
        dirty: true,
      })
      await render(b)
      expect(container.querySelector('textarea')).toBeNull()
      await click('remote.txt')
      expect(container.querySelector('textarea')?.value).toBe('original')
      expect(button('Save').disabled).toBe(true)
      expect(useRemoteFileDrafts.getState().bySession[b]).toBeUndefined()
      // A dirty lane remains protected from a path-link open while unmounted.
      await expect(openRemoteFile(a, 'other.txt')).rejects.toThrow()
      if (outcome === 'conflict') {
        hostContent = 'changed on Host'
        hostRevision = 'b'.repeat(64)
      }
      const reads = invoke.mock.calls.filter(([c]) => c === 'fs:readFile').length
      await render(a)
      expect(container.querySelector('textarea')?.value).toBe('edited')
      expect(button('Save').disabled).toBe(false)
      expect(button('other.txt').disabled).toBe(true)
      expect(invoke.mock.calls.filter(([c]) => c === 'fs:readFile')).toHaveLength(reads)
      if (outcome.startsWith('pending-')) {
        await click('Save')
        await render(b)
        if (outcome === 'pending-success-unmounted') {
          await act(async () => settlePending?.())
          expect(useRemoteFileDrafts.getState().bySession[a]).toBeUndefined()
          // A chat file link reaches the saved lane's Files again.
          await expect(openRemoteFile(a, 'other.txt')).resolves.toBeUndefined()
          return
        }
        if (outcome === 'pending-forget') {
          await act(async () => forgetRemoteSession(a))
          await act(async () => settlePending?.())
          expect(useRemoteFileDrafts.getState().bySession[a]).toBeUndefined()
          return
        }
        await render(a)
        expect(container.querySelector('textarea')?.value).toBe('edited')
        expect(container.querySelector('textarea')?.readOnly).toBe(true)
        expect(button('Save').disabled).toBe(true)
        await click('Editor save')
        expect(invoke.mock.calls.filter(([c]) => c === 'fs:writeFile')).toHaveLength(1)
        await act(async () => settlePending?.())
        expect(container.querySelector('textarea')?.readOnly).toBe(false)
        expect(container.querySelector('textarea')?.value).toBe('edited')
        expect(button('Save').disabled).toBe(outcome !== 'pending-conflict')
        if (outcome === 'pending-success') {
          expect(useRemoteFileDrafts.getState().bySession[a]).toBeUndefined()
          expect(container.textContent).not.toContain('Discard edits')
        } else {
          expect(useRemoteFileDrafts.getState().bySession[a]?.content).toBe('edited')
          expect(container.textContent).toContain(
            outcome === 'pending-conflict' ? 'File changed on disk' : 'Do not retry',
          )
        }
        return
      }
      if (outcome === 'forget') {
        await render(b)
        await act(async () => forgetRemoteSession(a))
        expect(useRemoteFileDrafts.getState().bySession[a]).toBeUndefined()
        expect(useRemoteFileSelection.getState().blocked[a]).toBeUndefined()
        expect(useSessionsStore.getState().live[a]).toBeUndefined()
        return
      }
      if (outcome === 'discard') await click('Discard edits')
      else {
        await click('Save')
        expect(invoke).toHaveBeenCalledWith(
          'fs:writeFile',
          `${mockRemoteInfo.workspacePath}/remote.txt`,
          'edited',
          originalRevision,
        )
      }
      if (outcome === 'conflict' || outcome === 'unknown') {
        expect(useRemoteFileDrafts.getState().bySession[a]?.content).toBe('edited')
        expect(container.textContent).toContain(
          outcome === 'conflict' ? 'File changed on disk' : 'Do not retry',
        )
        await render(b)
        await render(a)
        expect(container.querySelector('textarea')?.value).toBe('edited')
        expect(button('Save').disabled).toBe(outcome === 'unknown')
        expect(container.textContent).toContain(
          outcome === 'conflict' ? 'File changed on disk' : 'Do not retry',
        )
        await click(outcome === 'unknown' ? 'Reload file' : 'Discard edits')
      }
      expect(useRemoteFileDrafts.getState().bySession[a]).toBeUndefined()
      await render(b)
      await render(a)
      expect(container.querySelector('textarea')).toBeNull()
      await click('remote.txt')
      expect(container.querySelector('textarea')?.value).toBe(hostContent)
      expect(button('Save').disabled).toBe(true)
    } finally {
      act(() => root.unmount())
    }
  },
)
