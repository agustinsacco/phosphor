// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TopBar } from './TopBar'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useArtifactsStore } from '@/stores/artifacts'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteHosts, MOCK_HOST_ID, mockRemoteInfo } from '@/dev/mockRemoteLanes'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/features/workspaces/WorkspaceChip', () => ({ WorkspaceChip: () => null }))
vi.mock('@/features/worktrees/BranchControl', () => ({ BranchControl: () => null }))
vi.mock('@/features/chat/SessionMenu', () => ({ SessionMenu: () => null }))
vi.mock('@/features/chat/composer/SwarmSwitch', () => ({ SwarmBadge: () => null }))
it.each([
  ['mac', 'bee1-a', 'mac'],
  ['bee1-a', 'bee1-b', 'bee1-a'],
])('top bar switches title and artifact count: %j', async (...sequence) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn().mockResolvedValue(undefined) })
  useSessionsStore.setState({
    live: {
      mac: { phosphorId: 'mac', workspacePath: '/mac' },
      'bee1-a': { ...mockRemoteInfo, phosphorId: 'bee1-a' },
      'bee1-b': {
        ...mockRemoteInfo,
        workspacePath: 'host:bee1/lane:other-lane',
        laneId: 'other',
        phosphorId: 'bee1-b',
      },
    },
  })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts) })
  useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.capabilities.push('artifacts.read')
  useChatStore.setState({ sessions: {} })
  useArtifactsStore.setState({ bySession: {} })
  for (const [id, count] of [
    ['mac', 1],
    ['bee1-a', 0],
    ['bee1-b', 2],
  ] as const) {
    useChatStore.getState().ensure(id)
    useChatStore.getState().setMeta(id, {
      sessionId: id,
      sessionName: `Title ${id}`,
      isStreaming: false,
      isCompacting: false,
      thinkingLevel: 'off',
      steeringMode: 'all',
      followUpMode: 'all',
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    })
    for (let n = 0; n < count; n++)
      useArtifactsStore
        .getState()
        .addLocal(id, { title: `${id}-${n}`, type: 'markdown', content: 'document' })
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    for (const id of sequence) {
      await act(async () => {
        useSessionsStore.setState({ activeSessionId: id })
        root.render(<TopBar workspacePath={id === 'mac' ? '/mac' : mockRemoteInfo.workspacePath} />)
      })
      expect(container.textContent).toContain(`Title ${id}`)
      for (const other of ['mac', 'bee1-a', 'bee1-b'].filter((x) => x !== id))
        expect(container.textContent).not.toContain(`Title ${other}`)
      const count = id === 'mac' ? 1 : id === 'bee1-b' ? 2 : 0
      expect(container.querySelector('[data-tooltip="Artifacts pane"]') !== null).toBe(true)
      if (count)
        expect(container.querySelector(`[data-tooltip="${count} artifacts"]`)).not.toBeNull()
    }
    await act(async () => {
      useSessionsStore.setState({ activeSessionId: 'bee1-a' })
      const hosts = structuredClone(mockRemoteHosts)
      hosts[MOCK_HOST_ID]!.capabilities = ['sessions.read']
      useRemoteLanesStore.setState({ hosts })
    })
    expect(container.querySelector('[data-tooltip="Artifacts pane"]')).toBeNull()
    await act(async () => {
      const hosts = structuredClone(mockRemoteHosts)
      hosts[MOCK_HOST_ID]!.capabilities.push('artifacts.read')
      hosts[MOCK_HOST_ID]!.state = 'reconnecting'
      useRemoteLanesStore.setState({ hosts })
    })
    expect(container.querySelector('[data-tooltip="Artifacts pane"]')).toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
