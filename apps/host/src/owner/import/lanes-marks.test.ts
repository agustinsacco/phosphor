import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { CLAUDE_LANE, piTranscript } from '../../lanes/__fixtures__/pi-transcript'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MigrationLaneItem } from '@phosphor/shared/host-protocol-owner'
import { sessionFileName } from '@phosphor/shared/visible-lanes'
import { OwnerCallRefused } from '../adapter'
import { withStateDatabase } from '../staging'
import { scratchHost, uid, type ScratchHost } from './__fixtures__/scratch-host'
import { LANE_REFUSALS, laneImporter } from './lanes'
import { markImporter, rewoundLinks } from './marks'

let host: ScratchHost
let repo: string
beforeEach(async () => {
  host = await scratchHost({ lanesPerHost: 4 })
  repo = host.folder('repo')
  host.store.syncRepositories([repo])
})
afterEach(() => host.close())

function item(overrides: Partial<MigrationLaneItem> = {}): MigrationLaneItem {
  return {
    laneId: randomUUID(),
    sessionFile: host.session('repo'),
    cwd: repo,
    rootPath: repo,
    worktree: false,
    title: 'Fix the sidebar',
    branch: 'fix/sidebar',
    model: { provider: 'anthropic', id: 'claude-x' },
    createdAt: '2025-03-01T10:00:00.000Z',
    updatedAt: '2025-03-04T10:00:00.000Z',
    ...overrides,
  }
}

const importLanes = (items: MigrationLaneItem[], merge = false) =>
  laneImporter(host.ports).apply({ section: 'lanes', items }, host.context(merge))

describe('lanes', () => {
  it('ensureLane keyed by session file: Desktop’s id, title, branch, model and times', async () => {
    const lane = item()
    await importLanes([lane])
    expect(host.store.sessionLane(lane.sessionFile)).toMatchObject({
      laneId: lane.laneId,
      repositoryId: host.store.listRepositories()[0]!.id,
      cwd: repo,
      title: 'Fix the sidebar',
      branch: 'fix/sidebar',
      model: { provider: 'anthropic', id: 'claude-x' },
      createdAt: lane.createdAt,
      updatedAt: lane.updatedAt,
    })
    await importLanes([lane])
    expect(host.store.listLanes()).toHaveLength(1)
  })

  it('a session file the daemon already has keeps the daemon’s lane', async () => {
    const lane = item()
    const own = host.store.ensureLane({
      repositoryId: host.store.listRepositories()[0]!.id,
      cwd: repo,
      sessionFile: lane.sessionFile,
    })
    await importLanes([lane], true)
    expect(host.store.listLanes().map((l) => l.laneId)).toEqual([own.laneId])
    expect(host.events).toContainEqual({
      event: 'owner.migrate.lane_kept',
      fields: { laneId: own.laneId },
    })
  })

  it('refuses a lane whose folder was not imported, writing none of the section', async () => {
    const outside = host.folder('outside')
    const imported = importLanes([item(), item({ cwd: outside, rootPath: outside })])
    await expect(imported).rejects.toEqual(
      new OwnerCallRefused('bad-request', LANE_REFUSALS.folder),
    )
    expect(host.store.listLanes()).toEqual([])
  })

  it('refuses more lanes than the store holds, counting the daemon’s own, before any write', async () => {
    await importLanes([item(), item()])
    const imported = importLanes([item(), item(), item()])
    await expect(imported).rejects.toEqual(
      new OwnerCallRefused('too-large', LANE_REFUSALS.tooMany(4)),
    )
    expect(host.store.listLanes()).toHaveLength(2)
  })

  it('drops a model name too long for the store, never the lane', async () => {
    const lane = item({ model: { provider: 'p', id: 'm'.repeat(129) } })
    await importLanes([lane])
    expect(host.store.sessionLane(lane.sessionFile)?.model).toBeNull()
  })

  it('reads a lane’s model from its transcript when Desktop sent none', async () => {
    const lane = item({ model: null })
    writeFileSync(lane.sessionFile, piTranscript(CLAUDE_LANE))
    const silent = item({ model: null })
    await importLanes([lane, silent])
    expect(host.store.sessionLane(lane.sessionFile)?.model).toEqual({
      provider: 'pi-claude-cli',
      id: 'claude-opus-5',
    })
    expect(host.store.sessionLane(silent.sessionFile)?.model).toBeNull()
    expect(host.events).toContainEqual({
      event: 'owner.migrate.lane_models_read',
      fields: { repaired: 1, skipped: 1, unreadable: 0 },
    })
  })
})

describe('rewoundLinks', () => {
  const lanes: Record<string, string> = { a: 'lane-a', c: 'lane-c', d: 'lane-d', x: 'lane-x' }
  const laneOf = (name: string) => lanes[name]

  it('links a successor to its predecessor’s lane, matching Desktop’s file names', () => {
    expect(rewoundLinks({ '/s/one/a': '/s/two/c' }, laneOf).links).toEqual({ 'lane-c': 'lane-a' })
  })

  it('collapses a chain through a file that was not imported: A → B → C links C to A', () => {
    expect(rewoundLinks({ a: 'b', b: 'c' }, laneOf)).toEqual({
      links: { 'lane-c': 'lane-a' },
      conflicts: 0,
      cycles: 0,
    })
  })

  it('leaves out a loop and counts it once per successor on it', () => {
    expect(rewoundLinks({ a: 'c', c: 'a', d: 'x' }, laneOf)).toEqual({
      links: { 'lane-x': 'lane-d' },
      conflicts: 0,
      cycles: 2,
    })
  })

  it('keeps the first predecessor in name order when two claim one successor', () => {
    expect(rewoundLinks({ d: 'c', a: 'c' }, laneOf)).toEqual({
      links: { 'lane-c': 'lane-a' },
      conflicts: 1,
      cycles: 0,
    })
  })
})

describe('marks', () => {
  const prefs = () =>
    withStateDatabase(host.state, uid, (db) =>
      db.prepare(`SELECT lane_id,value FROM lane_prefs WHERE key='rewound_from'`).all(),
    )

  it('pins, markers and unread; rewound_from holds the predecessor’s lane id', async () => {
    const [a, b, c] = [item(), item(), item()]
    await importLanes([a, c])
    await markImporter(host.ports).apply(
      {
        section: 'marks',
        items: [
          { sessionFile: a.sessionFile, pinned: true, marker: '🔥' },
          { sessionFile: c.sessionFile, unread: true },
          { sessionFile: b.sessionFile, pinned: true },
        ],
        rewound: { [a.sessionFile]: b.sessionFile, [b.sessionFile]: c.sessionFile },
      },
      host.context(),
    )
    const lane = (file: string) => host.store.sessionLane(file)!
    expect(lane(a.sessionFile)).toMatchObject({ pinned: true, marker: '🔥' })
    expect(lane(c.sessionFile).attention).toBeGreaterThan(lane(c.sessionFile).read)
    expect(lane(a.sessionFile).attention).toBe(lane(a.sessionFile).read)
    expect(await prefs()).toEqual([{ lane_id: c.laneId, value: a.laneId }])
    expect(host.store.folders.rewoundFiles()).toEqual({
      [sessionFileName(a.sessionFile)]: sessionFileName(c.sessionFile),
    })
    expect(host.events).toContainEqual({
      event: 'owner.migrate.marks_skipped',
      fields: { count: 1 },
    })
  })

  it('logs a loop once and writes no link for it', async () => {
    const [a, b] = [item(), item()]
    await importLanes([a, b])
    await markImporter(host.ports).apply(
      {
        section: 'marks',
        items: [],
        rewound: { [a.sessionFile]: b.sessionFile, [b.sessionFile]: a.sessionFile },
      },
      host.context(),
    )
    expect(await prefs()).toEqual([])
    expect(host.events.filter((e) => e.event === 'owner.migrate.rewound_cycles')).toEqual([
      { event: 'owner.migrate.rewound_cycles', fields: { count: 2 } },
    ])
  })
})
