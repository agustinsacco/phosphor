import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionPush } from '@phosphor/shared/models'
import { RELEASE_STATUS_KEY } from '@phosphor/pi-extensions/release-status'
import type { StoredLane } from './store'
import { createReleaseKeeper } from './release-keeper'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const releaseText = (enabled: boolean) =>
  JSON.stringify({ version: 1, available: true, enabled, role: 'standby', quiet: false })

function fixture(recorded?: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'host-release-'))
  dirs.push(directory)
  if (recorded)
    writeFileSync(
      join(directory, 'release-lanes.json'),
      JSON.stringify({ version: 1, lanes: recorded }),
    )
  let listener!: (laneId: string, push: SessionPush) => void
  const timers: Array<{ ms: number; work: () => void }> = []
  const running = new Set<string>()
  const lanes = new Map<string, Partial<StoredLane>>([
    ['a', { laneId: 'a', removedAt: null, sessionFile: '/s/a.jsonl' }],
    ['b', { laneId: 'b', removedAt: null, sessionFile: '/s/b.jsonl' }],
    ['gone', { laneId: 'gone', removedAt: '2026-11-01T00:00:00Z', sessionFile: '/s/g.jsonl' }],
  ])
  let clock = 0
  let ready = true
  const resumeLane = vi.fn(async (lane: StoredLane) => void running.add(lane.laneId))
  const log = vi.fn()
  const keeper = createReleaseKeeper({
    directory,
    store: { getLane: (id) => (lanes.get(id) as StoredLane | undefined) ?? null },
    live: {
      observe: (fn) => {
        listener = fn
        return () => {}
      },
      sessionFor: (id) => (running.has(id) ? 'pi' : null),
    },
    resumeLane,
    ready: () => ready,
    log,
    now: () => clock,
    later: (work, ms) => void timers.push({ work, ms }),
  })
  const status = (laneId: string, enabled: boolean) =>
    listener(laneId, {
      kind: 'extension-ui',
      request: {
        type: 'extension_ui_request',
        id: 's',
        method: 'setStatus',
        statusKey: RELEASE_STATUS_KEY,
        statusText: releaseText(enabled),
      },
    })
  const exit = (laneId: string, expected: boolean) => {
    running.delete(laneId)
    listener(laneId, { kind: 'exit', code: expected ? 0 : 1, signal: null, expected })
  }
  const fire = async () => {
    const due = timers.splice(0)
    for (const timer of due) timer.work()
    await Promise.resolve()
    await Promise.resolve()
    return due.map((timer) => timer.ms)
  }
  const record = () =>
    (JSON.parse(readFileSync(join(directory, 'release-lanes.json'), 'utf8')) as { lanes: string[] })
      .lanes
  return {
    keeper,
    log,
    resumeLane,
    status,
    exit,
    fire,
    record,
    running,
    lanes,
    timers,
    tick: (ms: number) => (clock += ms),
    drain: () => (ready = false),
  }
}

describe('release keep-alive', () => {
  it('records a lane when release mode turns on and forgets it when it turns off', () => {
    const f = fixture()
    f.status('a', true)
    expect(f.record()).toEqual(['a'])
    f.status('a', true)
    f.status('b', false)
    expect(f.record()).toEqual(['a'])
    f.status('a', false)
    expect(f.record()).toEqual([])
  })

  it('resumes recorded lanes when the Host starts, one at a time, skipping deleted lanes', async () => {
    const f = fixture(['a', 'gone', 'b'])
    expect(f.timers.map((timer) => timer.ms)).toEqual([2000, 4000, 6000])
    await f.fire()
    expect(f.resumeLane.mock.calls.map(([lane]) => lane.laneId)).toEqual(['a', 'b'])
    expect(f.keeper.lanes()).toEqual(['a', 'b'])
    expect(f.record()).toEqual(['a', 'b'])
  })

  it('restarts after an unexpected exit, backing off, and starts over once steady', async () => {
    const f = fixture()
    f.status('a', true)
    f.running.add('a')
    f.exit('a', false)
    expect(await f.fire()).toEqual([30_000])
    f.exit('a', false)
    expect(await f.fire()).toEqual([60_000])
    f.exit('a', false)
    expect(await f.fire()).toEqual([120_000])
    f.tick(10 * 60_000)
    f.exit('a', false)
    expect(await f.fire()).toEqual([30_000])
    expect(f.resumeLane).toHaveBeenCalledTimes(4)
  })

  it('pauses on a deliberate stop, and keeps the record through a drain', async () => {
    const f = fixture()
    f.status('a', true)
    f.status('b', true)
    f.running.add('a').add('b')
    f.exit('a', true)
    expect(f.record()).toEqual(['b'])
    f.drain()
    f.exit('b', false)
    expect(f.timers).toEqual([])
    expect(f.record()).toEqual(['b'])
  })

  it('gives up after repeated failed resumes, and leaves a live lane alone', async () => {
    const f = fixture()
    f.status('a', true)
    f.resumeLane.mockRejectedValue(new Error('no pi'))
    f.exit('a', false)
    const delays: number[] = []
    for (let i = 0; i < 10 && f.timers.length; i++) delays.push(...(await f.fire()))
    expect(delays).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000,
    ])
    expect(f.keeper.lanes()).toEqual([])
    const g = fixture()
    g.status('b', true)
    g.exit('b', false)
    g.running.add('b') // The user resumed it first.
    await g.fire()
    expect(g.resumeLane).not.toHaveBeenCalled()
  })

  it('ignores a record of another version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'host-release-'))
    dirs.push(directory)
    writeFileSync(join(directory, 'release-lanes.json'), '{"version":2,"lanes":["a"]}')
    const again = createReleaseKeeper({
      directory,
      store: { getLane: () => null },
      live: { observe: () => () => {}, sessionFor: () => null },
      resumeLane: vi.fn(),
      ready: () => true,
      log: vi.fn(),
      later: vi.fn(),
    })
    expect(again.lanes()).toEqual([])
  })

  it('starts empty, and says so, when the record is damaged rather than failing the Host', () => {
    for (const damage of ['{', 'null', 'folder']) {
      const directory = mkdtempSync(join(tmpdir(), 'host-release-'))
      dirs.push(directory)
      const path = join(directory, 'release-lanes.json')
      if (damage === 'folder') mkdirSync(path)
      else writeFileSync(path, damage)
      const log = vi.fn()
      const keeper = createReleaseKeeper({
        directory,
        store: { getLane: () => null },
        live: { observe: () => () => {}, sessionFor: () => null },
        resumeLane: vi.fn(),
        ready: () => true,
        log,
        later: vi.fn(),
      })
      expect(keeper.lanes()).toEqual([])
      // `null` parses: like another version, it is simply not a record of lanes.
      if (damage !== 'null')
        expect(log).toHaveBeenCalledWith('release.keepalive_unreadable', expect.anything())
    }
  })

  it('pauses on request, so a crashed lane the user stops stays down', async () => {
    const f = fixture()
    f.status('a', true)
    f.running.add('a')
    f.exit('a', false)
    f.keeper.pause('a')
    expect(f.record()).toEqual([])
    f.status('a', true) // Recorded again by a later run: the old restart stays cancelled.
    await f.fire()
    expect(f.resumeLane).not.toHaveBeenCalled()
  })

  it('counts a failed restart once, though the failed start also reports an exit', async () => {
    const f = fixture()
    f.status('a', true)
    f.running.add('a')
    f.exit('a', false)
    f.resumeLane.mockImplementationOnce(async () => {
      f.exit('a', false)
      throw new Error('the lane could not start')
    })
    expect(await f.fire()).toEqual([30_000])
    expect(f.timers.map((timer) => timer.ms)).toEqual([60_000])
    f.exit('a', false) // Another exit while a restart is already due adds nothing.
    expect(f.timers.map((timer) => timer.ms)).toEqual([60_000])
  })

  it('says when it is full rather than silently dropping a lane', () => {
    const f = fixture()
    for (let i = 0; i < 65; i++) f.status(`l${i}`, true)
    expect(f.keeper.lanes()).toHaveLength(64)
    expect(f.log).toHaveBeenCalledWith('release.keepalive_full', { laneId: 'l64' })
  })
})
