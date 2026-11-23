import { describe, expect, it } from 'vitest'
import { OWNER_LIMITS } from '@phosphor/shared/host-protocol-owner'
import type { ControlLink } from '../control/link'
import type { StoredLane } from '../lanes/store'
import { ownerIndex, type OwnerIndexPorts } from './index-call'

const SESSION = '0f3c9a1e-1111-4aaa-8bbb-123456789abc'

function lane(n: number, sessionFile: string | null = null): StoredLane {
  const laneId = `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
  return {
    laneId,
    repositoryId: 'a'.repeat(16),
    cwd: `/srv/a/${n}`,
    sessionFile,
    removedAt: null,
  } as StoredLane
}

function ports(lanes: StoredLane[], overrides: Partial<OwnerIndexPorts> = {}): OwnerIndexPorts {
  return {
    machineId: 'm'.repeat(32),
    agentDir: '/home/u/.pi/agent',
    sessionsRoot: '/home/u/.pi/agent/sessions',
    daemon: { standby: () => false, link: () => null },
    // Newest first, as a store might list them: the index orders by lane id itself.
    store: { listLanes: () => [...lanes].reverse() },
    ownerLock: async () => ({ owner: 'daemon', pid: 42 }),
    pid: 42,
    ...overrides,
  }
}

describe('owner.index', () => {
  it('lists lanes with the session id from pi file names, and null for any other name', async () => {
    const index = await ownerIndex(
      ports([
        lane(1, `/s/--srv-a--/2026-01-01T00-00-00-000Z_${SESSION}.jsonl`),
        lane(2, '/s/--srv-a--/handwritten.jsonl'),
        lane(3, null),
      ]),
      {},
    )
    expect(index).toEqual({
      machineId: 'm'.repeat(32),
      agentDir: '/home/u/.pi/agent',
      sessionsRoot: '/home/u/.pi/agent/sessions',
      owning: true,
      migrateLevel: 1,
      lanes: [
        {
          laneId: lane(1).laneId,
          sessionFile: `/s/--srv-a--/2026-01-01T00-00-00-000Z_${SESSION}.jsonl`,
          sessionId: SESSION,
          cwd: '/srv/a/1',
          repositoryId: 'a'.repeat(16),
        },
        expect.objectContaining({ laneId: lane(2).laneId, sessionId: null }),
        expect.objectContaining({ laneId: lane(3).laneId, sessionFile: null, sessionId: null }),
      ],
    })
  })

  it('pages by lane id; rows without a session id still count toward a page', async () => {
    const all = Array.from({ length: OWNER_LIMITS.indexLanesPerPage + 2 }, (_, i) => lane(i + 1))
    const first = await ownerIndex(ports(all), {})
    expect(first.lanes).toHaveLength(OWNER_LIMITS.indexLanesPerPage)
    expect(first.next).toBe(all[OWNER_LIMITS.indexLanesPerPage - 1]?.laneId)
    const second = await ownerIndex(ports(all), { after: first.next })
    expect(second.lanes.map((l) => l.laneId)).toEqual(all.slice(-2).map((l) => l.laneId))
    expect(second.next).toBeUndefined()
  })

  it('is not owning in standby or while another process holds the lock, and names the enrolled host', async () => {
    const link = {
      state: () => ({ kind: 'enrolled', hostId: 'h'.repeat(32), label: 'mac', ownerLogin: null }),
    } as unknown as ControlLink
    const standby = await ownerIndex(
      ports([], { daemon: { standby: () => true, link: () => null } }),
      {},
    )
    expect(standby.owning).toBe(false)
    expect(standby.enrolledHostId).toBeUndefined()
    const desktop = await ownerIndex(
      ports([], {
        daemon: { standby: () => false, link: () => link },
        ownerLock: async () => ({ owner: 'desktop', pid: 7 }),
      }),
      {},
    )
    expect(desktop).toMatchObject({ owning: false, enrolledHostId: 'h'.repeat(32) })
  })
})
