import type { HostsSnapshot } from '@shared/ipc'
import type { LiveSessionInfo } from '@shared/models'

export const MOCK_HOST_ID = '00000000-0000-4000-8000-000000000099'
const LANE = '00000000-0000-4000-8000-000000000098'
export const mockRemoteInfo: LiveSessionInfo = {
  sessionId: 'remote-0000000000000099',
  workspacePath: `host:${MOCK_HOST_ID}/0000000000000001`,
  target: { kind: 'remote', hostId: MOCK_HOST_ID },
  laneId: LANE,
}
export const mockRemoteHosts: HostsSnapshot = {
  [MOCK_HOST_ID]: {
    state: 'ready',
    capabilities: ['sessions.read', 'sessions.control'],
    repositories: [{ id: '0000000000000001', name: 'Demo repository', path: '/remote/demo' }],
    lanes: [
      {
        laneId: LANE,
        repositoryId: '0000000000000001',
        cwd: '/remote/demo',
        title: 'Remote demo lane',
        branch: null,
        worktree: false,
        model: null,
        activity: 'idle',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        attention: 1,
        read: 0,
        control: {
          fence: 1,
          controller: { label: 'Another Desktop', connected: true, self: false },
        },
      },
    ],
  },
}

const listeners = new Set<() => void>()
export function onMockRemoteChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function mockRemoteAction(channel: string): void {
  const host = mockRemoteHosts[MOCK_HOST_ID]
  const lane = host?.lanes[0]
  if (!host || !lane) return
  host.lanes = [
    {
      ...lane,
      ...(channel === 'hosts:takeControl'
        ? {
            control: {
              fence: lane.control.fence + 1,
              controller: { self: true, label: 'This Desktop', connected: true },
            },
          }
        : {}),
      ...(channel === 'hosts:markRead' ? { read: lane.attention } : {}),
      ...(channel === 'hosts:stopLane' ? { activity: 'stopped' as const } : {}),
      ...(channel === 'hosts:resumeLane' ? { activity: 'idle' as const } : {}),
    },
  ]
  for (const listener of listeners) listener()
}
