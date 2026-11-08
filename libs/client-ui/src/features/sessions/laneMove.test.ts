import { describe, expect, it } from 'vitest'
import type { HostsSnapshot } from '@shared/ipc'
import { MOCK_HOST_ID, mockRemoteHosts } from '@/dev/mockRemoteLanes'
import { MOVE_HINTS, formatMoveBytes, moveMachines, planSummary, sourceHint } from './laneMove'

const base = mockRemoteHosts[MOCK_HOST_ID]!
const hostsWith = (edit: Partial<typeof base>): HostsSnapshot => ({
  [MOCK_HOST_ID]: { ...base, ...edit },
})
const capable = {
  laneTransfer: true,
  capabilities: [
    'sessions.read',
    'sessions.control',
    'workspaces.write',
  ] as typeof base.capabilities,
}
const recents = [{ path: '/work/app', name: 'app', lastOpenedAt: 1 }]

describe('moveMachines', () => {
  it('lists This Mac first, with recent folders and sandboxes once each', () => {
    const machines = moveMachines({
      hosts: {},
      labelOf: () => 'unused',
      recents,
      sandboxes: [
        { path: '/work/app', name: 'app', itemCount: 0, modifiedAt: 0 },
        { path: '/sand/quiet-fox', name: 'quiet-fox', itemCount: 0, modifiedAt: 0 },
      ] as never,
    })
    expect(machines).toHaveLength(1)
    expect(machines[0]!.workspaces.map((w) => w.target)).toEqual([
      { machine: 'local', workspace: '/work/app' },
      { machine: 'local', workspace: '/sand/quiet-fox' },
    ])
  })

  it('keeps a Host that cannot take the lane, with the reason', () => {
    const reason = (edit: Partial<typeof base>) =>
      moveMachines({ hosts: hostsWith(edit), labelOf: () => 'Box', recents, sandboxes: [] })[1]!
        .disabled
    expect(reason({ state: 'offline' } as never)).toBe(MOVE_HINTS.offline)
    expect(reason({ laneTransfer: undefined })).toBe(MOVE_HINTS.outdated)
    expect(reason({ laneTransfer: true, capabilities: ['sessions.read'] })).toBe(MOVE_HINTS.control)
    expect(reason({ ...capable, repositories: [] })).toBe(MOVE_HINTS.noWorkspaces)
    expect(reason(capable)).toBeUndefined()
  })

  it('targets a Host repository by id', () => {
    const [, host] = moveMachines({
      hosts: hostsWith(capable),
      labelOf: () => 'Box',
      recents,
      sandboxes: [],
    })
    expect(host!.workspaces[0]!.target).toEqual({
      machine: MOCK_HOST_ID,
      repositoryId: base.repositories[0]!.id,
    })
  })
})

describe('sourceHint', () => {
  it('lets This Mac always send, and names why a Host cannot', () => {
    expect(sourceHint({}, { machine: 'local', sessionPath: '/s.jsonl' })).toBeUndefined()
    const source = { machine: MOCK_HOST_ID, laneId: 'x' }
    expect(sourceHint({}, source)).toBe(MOVE_HINTS.offline)
    expect(sourceHint(hostsWith({ laneTransfer: undefined }), source)).toBe(MOVE_HINTS.outdated)
    expect(sourceHint(hostsWith({ laneTransfer: true, capabilities: [] }), source)).toBe(
      MOVE_HINTS.read,
    )
    expect(sourceHint(hostsWith(capable), source)).toBeUndefined()
  })
})

describe('planSummary and formatMoveBytes', () => {
  it('says what moves for each mode', () => {
    const plan = { blockers: [], bytes: 1, branch: 'agustin/x', workspace: '/w' }
    expect(planSummary({ ...plan, mode: 'same-workspace' as const })).toContain('same commit')
    expect(planSummary({ ...plan, mode: 'new-branch' as const })).toContain('code stays behind')
    expect(planSummary({ ...plan, mode: 'folder' as const })).toContain('files stay behind')
  })

  it('rounds small sizes up to 1 KB and shows MB with one decimal', () => {
    expect(formatMoveBytes(10)).toBe('1 KB')
    expect(formatMoveBytes(5 * 1024 * 1024 + 300_000)).toBe('5.3 MB')
  })
})
