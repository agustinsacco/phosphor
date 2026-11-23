import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { MigrationImport, MigrationSection } from '@phosphor/shared/host-protocol-owner'
import type { OwnerCallContext } from '../adapter'
import { createOwnerMigration } from '../migrate'
import { scratchHost, uid, type ScratchHost } from './__fixtures__/scratch-host'
import { migrationImporters, sectionImporters } from './index'

const call = {} as OwnerCallContext
let host: ScratchHost
let standby: boolean
beforeEach(async () => {
  host = await scratchHost()
  standby = true
})
afterEach(() => host.close())

function migration() {
  const { handlers } = createOwnerMigration({
    stateDirectory: host.state,
    uid,
    store: host.store,
    daemon: {
      standby: () => standby,
      leaveStandby: async () => {
        standby = false
      },
    },
    importers: sectionImporters(host.ports),
    refresh: async () => {},
    now: () => 1_000,
    log: () => {},
  })
  return {
    begin: (id: string) =>
      handlers['owner.migrate.begin']({ migrationId: id, desktopVersion: '1.2.3' }, call),
    import: (id: string, section: MigrationSection) => {
      const hash = createHash('sha256').update(JSON.stringify(section)).digest('hex')
      return handlers['owner.migrate.import'](
        { migrationId: id, hash, ...section } as MigrationImport,
        call,
      )
    },
    abort: (id: string) => handlers['owner.migrate.abort']({ migrationId: id }, call),
    commit: (id: string) => handlers['owner.migrate.commit']({ migrationId: id }, call),
  }
}

/** This Mac in miniature: one folder, one lane in it, pinned. */
function sections(): MigrationSection[] {
  const repo = host.folder('repo')
  const sessionFile = host.session('repo')
  return [
    { section: 'folders', items: [{ path: repo, name: 'repo', order: 0 }] },
    {
      section: 'lanes',
      items: [
        {
          laneId: randomUUID(),
          sessionFile,
          cwd: repo,
          rootPath: repo,
          worktree: false,
          title: 'Kept',
          branch: null,
          model: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-02T00:00:00.000Z',
        },
      ],
    },
    { section: 'marks', items: [{ sessionFile, pinned: true }], rewound: {} },
  ]
}

it('abort undoes every section: folders file, lanes and marks', async () => {
  const before = readFileSync(host.config)
  const m = migration()
  const id = randomUUID()
  await m.begin(id)
  for (const section of sections()) await m.import(id, section)
  expect(host.store.listLanes()).toHaveLength(1)
  expect(host.store.listLanes()[0]?.pinned).toBe(true)
  await m.abort(id)
  expect(host.store.listLanes()).toEqual([])
  expect(existsSync(join(host.root, 'config', 'folders.json'))).toBe(false)
  expect(readFileSync(host.config)).toEqual(before)
  expect(readdirSync(join(host.state, 'owner-migration'))).toEqual([])
})

it('a replayed section is a no-op, and commit keeps what was imported', async () => {
  const m = migration()
  const id = randomUUID()
  await m.begin(id)
  const all = sections()
  for (const section of all) await m.import(id, section)
  await expect(m.import(id, all[1]!)).resolves.toEqual({ staged: true, replayed: true })
  await m.commit(id)
  expect(host.store.listLanes().map((l) => l.title)).toEqual(['Kept'])
  expect(standby).toBe(false)
})

it('run’s importers cover every section the wire carries', () => {
  const importers = migrationImporters({
    env: { XDG_STATE_HOME: join(host.root, 'xdg') },
    home: host.root,
    configPath: host.config,
    uid,
  } as never)
  expect(Object.keys(importers).sort()).toEqual(
    ['accounts', 'archives', 'artifacts', 'folders', 'lanes', 'marks', 'policy', 'routines'].sort(),
  )
})
