// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RightPane } from './RightPane'
import { useLayoutStore } from '@/stores/layout'
import { useSessionsStore } from '@/stores/sessions'
import { mockRemoteInfo } from '@/dev/mockRemoteLanes'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./MonacoEditor', () => ({ MonacoDiff: () => null }))
vi.mock('./FilesPane', () => ({
  FilesPane: () => {
    throw new Error('Local Files mounted')
  },
}))
vi.mock('./FilesChangedPane', () => ({
  FilesChangedPane: () => {
    throw new Error('Local Changes mounted')
  },
}))
vi.mock('@/features/terminal/TerminalPane', () => ({
  TerminalPane: () => {
    throw new Error('Local Terminal mounted')
  },
}))
vi.mock('@/features/artifacts/ArtifactsPane', () => ({
  ArtifactsPane: () => {
    throw new Error('Local Artifacts mounted')
  },
}))
vi.mock('@/features/chat/SubagentPanel', () => ({
  SubagentPanel: () => {
    throw new Error('Local Subagents mounted')
  },
}))

it('never mounts local pane contents for a remote handle', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { onSessionPush: () => () => {} })
  Object.assign(window, { phosphor: { onSessionPush: () => () => {} } })
  useSessionsStore.setState({
    live: {
      [mockRemoteInfo.sessionId]: {
        phosphorId: mockRemoteInfo.sessionId,
        workspacePath: mockRemoteInfo.workspacePath,
        target: mockRemoteInfo.target,
        laneId: mockRemoteInfo.laneId,
      },
    },
  })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    for (const pane of ['files', 'changes', 'terminal', 'artifacts', 'subagents'] as const) {
      act(() => {
        useLayoutStore.getState().setRightPane(pane, mockRemoteInfo.sessionId)
        root.render(
          <RightPane
            sessionId={mockRemoteInfo.sessionId}
            workspacePath={mockRemoteInfo.workspacePath}
          />,
        )
      })
      expect(container.textContent).toContain('Not available on remote lanes yet.')
    }
  } finally {
    act(() => root.unmount())
  }
})

it('reloads a different lane in the same repository instead of retaining the first worktree files', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const { useRemoteLanesStore } = await import('@/stores/remoteLanes')
  const hostId = mockRemoteInfo.target?.kind === 'remote' ? mockRemoteInfo.target.hostId : ''
  const otherId = 'remote-fedcba9876543210'
  const invoke = vi.fn(async (channel: string) => (channel === 'fs:listFiles' ? ['file.ts'] : {}))
  vi.stubGlobal('phosphor', { invoke, onSessionPush: () => () => {} })
  const first = {
    phosphorId: mockRemoteInfo.sessionId,
    workspacePath: mockRemoteInfo.workspacePath,
    target: mockRemoteInfo.target,
    laneId: mockRemoteInfo.laneId,
  }
  useSessionsStore.setState({
    live: { [mockRemoteInfo.sessionId]: first, [otherId]: { ...first, phosphorId: otherId } },
  })
  useRemoteLanesStore.setState({
    hosts: {
      [hostId]: { state: 'ready', capabilities: ['workspaces.read'], lanes: [], repositories: [] },
    },
  })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    for (const sessionId of [mockRemoteInfo.sessionId, otherId]) {
      useLayoutStore.getState().setRightPane('files', sessionId)
      await act(async () =>
        root.render(
          <RightPane sessionId={sessionId} workspacePath={mockRemoteInfo.workspacePath} />,
        ),
      )
    }
    expect(invoke.mock.calls.filter(([channel]) => channel === 'fs:listFiles')).toHaveLength(2)
  } finally {
    act(() => root.unmount())
    useRemoteLanesStore.setState({ hosts: {} })
    vi.unstubAllGlobals()
  }
})
