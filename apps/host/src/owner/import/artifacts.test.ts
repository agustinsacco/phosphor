import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { scratchHost, snapshotFolder, type ScratchHost } from './__fixtures__/scratch-host'
import { artifactImporter } from './artifacts'
import { filesUnder } from './snapshot'

let host: ScratchHost
let source: string
beforeEach(async () => {
  host = await scratchHost()
  source = join(host.root, 'userData', 'artifacts')
})
afterEach(() => host.close())

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const target = () => join(host.state, 'artifacts')

function storeFile(root: string, part: 'blobs' | 'sessions', name: string, text: string) {
  mkdirSync(join(root, part), { recursive: true })
  writeFileSync(join(root, part, name), text)
}

/** Every file's bytes, mode and mtime: the source must come out exactly as it went in. */
async function fingerprint(root: string) {
  const files = await filesUnder(root)
  return files.map((file) => {
    const info = statSync(join(root, file))
    return [file, sha(readFileSync(join(root, file), 'utf8')), info.mode, info.mtimeMs]
  })
}

const importArtifacts = () =>
  artifactImporter(host.ports).apply({ section: 'artifacts', sourceDir: source }, host.context())

it('clones blobs and indexes into the daemon store, leaving the source unchanged', async () => {
  storeFile(source, 'blobs', sha('one'), 'one')
  storeFile(source, 'blobs', sha('two'), 'two')
  storeFile(source, 'sessions', 'session-aaaaaaaa.json', '{"format":2}')
  storeFile(source, 'sessions', 'notes.txt', 'not the store’s')
  const before = await fingerprint(source)
  await importArtifacts()
  expect(await fingerprint(source)).toEqual(before)
  expect(await filesUnder(target())).toEqual(
    [`blobs/${sha('one')}`, `blobs/${sha('two')}`, 'sessions/session-aaaaaaaa.json'].sort(),
  )
  expect(readFileSync(join(target(), 'sessions', 'session-aaaaaaaa.json'), 'utf8')).toBe(
    '{"format":2}',
  )
  expect(statSync(target()).mode & 0o777).toBe(0o700)
  expect(host.events).toContainEqual({
    event: 'owner.migrate.artifacts',
    fields: { indexes: 1, kept: 0, skipped: 1 },
  })
})

it('keeps an index the daemon already wrote, and replays without copying again', async () => {
  storeFile(source, 'sessions', 'session-bbbbbbbb.json', '{"from":"desktop"}')
  storeFile(target(), 'sessions', 'session-bbbbbbbb.json', '{"from":"daemon"}')
  await importArtifacts()
  await importArtifacts()
  expect(readFileSync(join(target(), 'sessions', 'session-bbbbbbbb.json'), 'utf8')).toBe(
    '{"from":"daemon"}',
  )
})

it('abort removes exactly the files the import added', async () => {
  storeFile(target(), 'blobs', sha('own'), 'own')
  storeFile(source, 'blobs', sha('own'), 'own')
  storeFile(source, 'blobs', sha('mac'), 'mac')
  storeFile(source, 'sessions', 'session-cccccccc.json', '{}')
  const importer = artifactImporter(host.ports)
  const folder = snapshotFolder(host, 'artifacts')
  await importer.snapshot!(folder)
  await importArtifacts()
  await importer.restore!(folder)
  expect(await filesUnder(target())).toEqual([`blobs/${sha('own')}`])
  expect(readdirSync(join(source, 'blobs'))).toHaveLength(2)
})
