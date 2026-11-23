import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { MigrationArchiveManifest } from '@phosphor/shared/host-protocol-owner'
import { OwnerCallRefused } from '../adapter'
import { scratchHost, snapshotFolder, type ScratchHost } from './__fixtures__/scratch-host'
import { ARCHIVE_REFUSALS, archiveImporter } from './archives'

let host: ScratchHost
let repo: string
let repositoryId: string
beforeEach(async () => {
  host = await scratchHost()
  repo = host.folder('repo')
  repositoryId = host.store.syncRepositories([repo])[0]!.id
})
afterEach(() => host.close())

const archiveDir = () => join(host.state, 'lane-archive')

/** A Desktop archive: its transcript parked beside where it was, the manifest rewritten by Desktop. */
function archived(overrides: Partial<MigrationArchiveManifest> = {}): MigrationArchiveManifest {
  const transcript = host.session('repo')
  renameSync(transcript, `${transcript}.archived`)
  const info = statSync(`${transcript}.archived`)
  return {
    version: 1,
    id: randomUUID(),
    title: 'Old work',
    cwd: repo,
    archivedAt: 1_700_000_000_000,
    state: 'archived',
    worktree: false,
    transcript,
    identity: { dev: info.dev, ino: info.ino, directory: dirname(transcript) },
    metadata: { repositoryId, draftKey: 'draft' },
    ...overrides,
  }
}

const importArchives = (manifests: MigrationArchiveManifest[]) =>
  archiveImporter(host.ports).apply({ section: 'archives', manifests }, host.context())

it('adopts each manifest under its new lane id with a tombstone, never moving the parked file', async () => {
  const manifest = archived()
  const parked = `${manifest.transcript!}.archived`
  const before = { bytes: readFileSync(parked), ino: statSync(parked).ino }
  await importArchives([manifest])
  expect(JSON.parse(readFileSync(join(archiveDir(), `${manifest.id}.json`), 'utf8'))).toEqual(
    manifest,
  )
  expect(host.store.getLane(manifest.id)).toMatchObject({
    sessionFile: manifest.transcript,
    title: 'Old work',
  })
  expect(host.store.getLane(manifest.id)?.removedAt).not.toBeNull()
  expect(host.store.archives.has(manifest.id)).toBe(true)
  expect({ bytes: readFileSync(parked), ino: statSync(parked).ino }).toEqual(before)
  expect(existsSync(manifest.transcript!)).toBe(false)
  await importArchives([manifest])
  expect(readdirSync(archiveDir())).toEqual([`${manifest.id}.json`])
})

it('keeps the manifest alone, with no tombstone, when its folder was not imported', async () => {
  const manifest = archived({ metadata: { repositoryId: 'f'.repeat(16) } })
  await importArchives([manifest])
  expect(existsSync(join(archiveDir(), `${manifest.id}.json`))).toBe(true)
  expect(host.store.getLane(manifest.id)).toBeNull()
  expect(host.events).toContainEqual({
    event: 'owner.migrate.archive_tombstones_skipped',
    fields: { folder: 1 },
  })
})

it('refuses an id that already holds a different archived lane', async () => {
  const manifest = archived()
  await importArchives([manifest])
  await expect(importArchives([{ ...manifest, cwd: host.folder('other') }])).rejects.toEqual(
    new OwnerCallRefused('forbidden', ARCHIVE_REFUSALS.taken),
  )
})

it('abort removes exactly the manifests the import added', async () => {
  const older = archived()
  await importArchives([older])
  writeFileSync(join(archiveDir(), 'notes.txt'), 'not ours')
  const importer = archiveImporter(host.ports)
  const folder = snapshotFolder(host, 'archives')
  await importer.snapshot!(folder)
  await importArchives([archived(), archived()])
  expect(readdirSync(archiveDir())).toHaveLength(4)
  await importer.restore!(folder)
  expect(readdirSync(archiveDir()).sort()).toEqual([`${older.id}.json`, 'notes.txt'].sort())
})
