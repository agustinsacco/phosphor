// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RightPane } from './RightPane'
import { useLayoutStore } from '@/stores/layout'
import { useSessionsStore } from '@/stores/sessions'
import { mockRemoteInfo } from '@/dev/mockRemoteLanes'

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
