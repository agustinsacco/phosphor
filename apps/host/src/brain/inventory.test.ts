import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { openStore } from '../lanes/store'
import { hostBrainLaneFolder } from './runtime'
import { createHostBrainInventory } from './inventory'

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const caller = (admit = true) => ({
  client: { id: randomUUID(), label: 'Harbor' },
  connectionId: randomUUID(),
  admit: () => admit,
})

async function host() {
  const state = realpathSync(await mkdtemp(join(tmpdir(), 'harbor-inventory-')))
  cleanups.push(() => rm(state, { recursive: true, force: true }))
  const store = await openStore(state, process.getuid?.(), {})
  cleanups.push(() => store.close())
  const sessions = join(state, 'sessions')
  mkdirSync(sessions)
  const lane = (cwd: string, name: string, header: unknown) => {
    mkdirSync(cwd, { recursive: true })
    const dir = sessionDirForCwd(cwd, sessions)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${name}.jsonl`)
    writeFileSync(file, `${JSON.stringify(header)}\n`)
    const repositoryId = store
      .syncRepositories([...store.listRepositories().map((r) => r.path), cwd])
      .find((r) => r.path === cwd)!.id
    return { file, stored: store.ensureLane({ repositoryId, cwd, sessionFile: file, title: name }) }
  }
  const inventory = createHostBrainInventory({
    store,
    sessionsRoot: sessions,
    reserved: () => [hostBrainLaneFolder(state)],
  })
  return { state, store, sessions, lane, inventory }
}

it('resolves a Host lane ID to the saved pi session ID and transcript, and back from that pair', async () => {
  const h = await host()
  const piId = randomUUID()
  const { file, stored } = h.lane(join(h.state, 'Ledger'), 'Ledger', {
    type: 'session',
    id: piId,
    cwd: join(h.state, 'Ledger'),
  })
  const expected = { laneId: stored.laneId, sessionId: piId, sessionPath: file, title: 'Ledger' }
  expect(h.inventory.lane(stored.laneId, caller())).toEqual(expected)
  expect(h.inventory.source({ sessionId: piId, sessionPath: file }, caller())).toEqual(expected)
  // A pair that does not match what pi saved is not this lane.
  expect(h.inventory.source({ sessionId: randomUUID(), sessionPath: file }, caller())).toBe(
    undefined,
  )
  expect(h.inventory.lane(stored.laneId, caller(false))).toBeUndefined()
  expect(h.inventory.lane('not-a-lane', caller())).toBeUndefined()
})

it('never resolves a reserved Brain Agent lane, a headerless transcript or a linked one', async () => {
  const h = await host()
  const folder = hostBrainLaneFolder(h.state)
  const reserved = h.lane(folder, 'Brain', { type: 'session', id: randomUUID(), cwd: folder })
  expect(h.inventory.lane(reserved.stored.laneId, caller())).toBeUndefined()
  const bare = h.lane(join(h.state, 'Kestrel'), 'Kestrel', { type: 'note' })
  expect(h.inventory.lane(bare.stored.laneId, caller())).toBeUndefined()
  const northwind = join(h.state, 'Northwind')
  const target = h.lane(northwind, 'real', { type: 'session', id: randomUUID(), cwd: northwind })
  const link = join(sessionDirForCwd(northwind, h.sessions), 'link.jsonl')
  symlinkSync(target.file, link)
  const repositoryId = h.store.listRepositories().find((r) => r.path === northwind)!.id
  const linked = h.store.ensureLane({ repositoryId, cwd: northwind, sessionFile: link, title: 'x' })
  expect(h.inventory.lane(linked.laneId, caller())).toBeUndefined()
})
