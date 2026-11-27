import { beforeEach, expect, it, vi } from 'vitest'
import { useChatStore } from '@/stores/chat'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { renameSavedHostLane } from './remoteLaneSessionHelpers'

vi.mock('@/features/agent-control/agentOps', () => ({
  OpDenied: class extends Error {},
  runAgentOp: vi.fn(async () => ({ status: 'ok' })),
}))
vi.mock('@/stores/hostsSnapshotRead', () => ({ refreshHostsSnapshot: vi.fn(async () => {}) }))

beforeEach(() => {
  useRemoteLanesStore.setState({
    hosts: {
      h1: {
        lanes: [{ laneId: 'L1', control: { fence: 3, controller: { self: true } } }],
      },
    } as never,
  })
  useChatStore.setState({ sessions: { s1: { items: [], meta: { sessionName: 'Old' } } } as never })
})

it('shows a live rename in the open chat at once, not only after its next event', async () => {
  await renameSavedHostLane('h1', 'L1', 'New', 's1')
  expect(useChatStore.getState().sessions.s1?.meta?.sessionName).toBe('New')
})
