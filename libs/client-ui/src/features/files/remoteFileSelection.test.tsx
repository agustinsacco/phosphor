// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionFileTarget } from './SessionFileTarget'
import { RemoteFilesPane } from './RemoteFilesPane'
import { PathLink } from '@/features/chat/tools/PathLink'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useRemoteFileSelection, openRemoteFile, remoteRelativePath } from './remoteFileSelection'
import { mockRemoteInfo, mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoDiff: () => null,
  MonacoEditor: ({
    value,
    path,
    reveal,
  }: {
    value: string
    path: string
    reveal?: { line: number }
  }) => (
    <pre data-model={path} data-line={reveal?.line}>
      {value}
    </pre>
  ),
}))
afterEach(() => {
  vi.unstubAllGlobals()
  useRemoteFileSelection.setState({ bySession: {}, blocked: {} })
})
it('opens a Host absolute tool path through an explicit lane and never reads the identical Mac path', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID])
  if (!host) throw new Error('fixture')
  host.capabilities = ['workspaces.read']
  host.lanes = host.lanes.map((l) => ({ ...l, cwd: '/same/repo' }))
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  const id = mockRemoteInfo.sessionId
  useSessionsStore.setState({
    activeSessionId: id,
    live: { [id]: { ...mockRemoteInfo, phosphorId: id } },
  })
  const invoke = vi.fn(async (channel: string, path: string) => {
    if (channel === 'fs:listFiles') return ['src/file.ts']
    if (channel === 'git:statusMap') throw new Error('not git')
    if (channel === 'fs:readFile' && path === `${mockRemoteInfo.workspacePath}/src/file.ts`)
      return { content: 'HOST CONTENT', binary: false, revision: 'a'.repeat(64) }
    throw new Error('Local disk must never run')
  })
  vi.stubGlobal('phosphor', { invoke })
  const element = document.createElement('div'),
    root = createRoot(element)
  try {
    await act(async () =>
      root.render(
        <>
          <SessionFileTarget.Provider value={id}>
            <PathLink path="/same/repo/src/file.ts" line={17} />
          </SessionFileTarget.Provider>
          <RemoteFilesPane
            workspacePath={mockRemoteInfo.workspacePath}
            sessionId={id}
            changes={false}
          />
        </>,
      ),
    )
    await act(async () => element.querySelector('button')?.click())
    expect(element.textContent).toContain('HOST CONTENT')
    expect(element.textContent).toContain('Git status is unavailable')
    expect(element.querySelector('[data-line="17"]')).not.toBeNull()
    expect(invoke.mock.calls.some(([, path]) => path === '/same/repo/src/file.ts')).toBe(false)
    await expect(openRemoteFile(id, '/outside/file.ts')).rejects.toThrow('Not available')
    expect(invoke.mock.calls.every(([, path]) => path.startsWith('host:'))).toBe(true)
  } finally {
    act(() => root.unmount())
  }
})
it('confines absolute and relative paths to the named lane and rejects aliases', () => {
  expect(remoteRelativePath('/host/worktree', 'host:h/lane:a', '/host/worktree/a.ts')).toBe('a.ts')
  for (const path of [
    '/host/main/a.ts',
    '../a.ts',
    'host:h/lane:b/a.ts',
    '/host/worktree-other/a.ts',
    '.git/config',
  ])
    expect(() => remoteRelativePath('/host/worktree', 'host:h/lane:a', path)).toThrow()
})
