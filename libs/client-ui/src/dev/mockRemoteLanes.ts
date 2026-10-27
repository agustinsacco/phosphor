import type { HostsSnapshot } from '@shared/ipc'
import type { LiveSessionInfo } from '@shared/models'

export const MOCK_HOST_ID = '00000000-0000-4000-8000-000000000099'
const LANE = '00000000-0000-4000-8000-000000000098'
export const mockRemoteInfo: LiveSessionInfo = {
  sessionId: 'remote-0000000000000099',
  workspacePath: `host:${MOCK_HOST_ID}/lane:${LANE}`,
  target: { kind: 'remote', hostId: MOCK_HOST_ID },
  laneId: LANE,
}
export const mockRemoteHosts: HostsSnapshot = {
  [MOCK_HOST_ID]: {
    state: 'ready',
    connectionToken: 'mock-connection-1',
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
      ...(channel === 'hosts:releaseControl'
        ? { control: { fence: lane.control.fence + 1, controller: null } }
        : {}),
      ...(channel === 'hosts:markRead' ? { read: lane.attention } : {}),
      ...(channel === 'hosts:stopLane' ? { activity: 'stopped' as const } : {}),
      ...(channel === 'hosts:resumeLane' ? { activity: 'idle' as const } : {}),
    },
  ]
  for (const listener of listeners) listener()
}

/** Opt-in screenshot directory. Ordinary harness and test defaults stay unchanged. */
export function mixedRemoteHosts(): HostsSnapshot {
  const base = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  base.capabilities.push(
    'skills.read',
    'routines',
    'artifacts.read',
    'workspaces.read',
    'workspaces.write',
    'machine.configure',
    'terminal',
  )
  base.configurationSupported = true
  base.machineShell = true
  for (const lane of base.lanes)
    lane.control.controller = { self: true, label: 'This Desktop', connected: true }
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
  ]
  return Object.fromEntries(
    ids.map((id, index) => [
      id,
      {
        ...structuredClone(base),
        state: (['ready', 'down', 'no-address', 'reconnecting', 'ready'] as const)[index]!,
        repositories:
          index === 2
            ? []
            : [{ id: '0000000000000001', name: 'Phosphor', path: '/remote/phosphor' }],
        lanes:
          index === 2 || index === 4
            ? []
            : base.lanes.flatMap((lane) => [
                {
                  ...lane,
                  title: 'Sidebar machine switcher',
                  cwd: '/remote/phosphor/worktree',
                  branch: 'feat/machine-switcher',
                  worktree: true,
                  activity: 'working' as const,
                  updatedAt: new Date(Date.now() - 120000).toISOString(),
                },
                {
                  ...lane,
                  laneId: '00000000-0000-4000-8000-000000000097',
                  title: 'Review connection handling',
                  activity: 'needs-input' as const,
                  branch: 'main',
                  updatedAt: new Date(Date.now() - 3600000).toISOString(),
                },
                {
                  ...lane,
                  laneId: '00000000-0000-4000-8000-000000000096',
                  title: 'Update the documentation',
                  attention: 0,
                  read: 0,
                  updatedAt: new Date(Date.now() - 86400000).toISOString(),
                },
              ]),
      },
    ]),
  )
}
