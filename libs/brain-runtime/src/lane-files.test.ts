import { appendFile, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LaneFiles } from './lane-files'
import { DeletedLaneError, readLaneEntries } from './transcript'
import type * as Transcript from './transcript'

vi.mock('./transcript', async (importOriginal) => {
  const real = await importOriginal<typeof Transcript>()
  return { ...real, readLaneEntries: vi.fn(real.readLaneEntries) }
})
const reads = vi.mocked(readLaneEntries)

const directories: string[] = []
afterEach(async () => {
  reads.mockClear()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function lane(name = 'Harbor sync') {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-lane-files-'))
  directories.push(directory)
  const file = join(directory, 'harbor.jsonl')
  await writeFile(file, JSON.stringify({ type: 'session_info', name }))
  return file
}
const renameLane = (file: string, name: string) =>
  appendFile(file, '\n' + JSON.stringify({ type: 'session_info', name }))

it('reads an unchanged lane once and hands that read to its caller', async () => {
  const file = await lane()
  const files = new LaneFiles()
  const first = await files.current(file)
  expect(first.title).toBe('Harbor sync')
  expect(first.entries).toHaveLength(1)
  await expect(files.current(file)).resolves.toEqual({ title: 'Harbor sync', cwd: null })
  expect(reads).toHaveBeenCalledTimes(1)
})

it('remembers the title from an ordinary read', async () => {
  const file = await lane()
  const files = new LaneFiles()
  await files.read(file)
  await expect(files.current(file)).resolves.toEqual({ title: 'Harbor sync', cwd: null })
  expect(reads).toHaveBeenCalledTimes(1)
})

it('remembers the session header cwd with the title', async () => {
  const file = await lane()
  await writeFile(
    file,
    [
      { type: 'session', id: 'kestrel-lane', cwd: '/projects/kestrel' },
      { type: 'session_info', name: 'Kestrel' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  const files = new LaneFiles()
  await files.read(file)
  await expect(files.current(file)).resolves.toEqual({ title: 'Kestrel', cwd: '/projects/kestrel' })
  expect(reads).toHaveBeenCalledTimes(1)
})

it('reads again after the file changes, and once more after it is archived', async () => {
  const file = await lane()
  const files = new LaneFiles()
  await files.current(file)
  await renameLane(file, 'Tom 1:1')
  await expect(files.current(file)).resolves.toMatchObject({ title: 'Tom 1:1' })
  await rename(file, `${file}.archived`)
  await expect(files.current(file)).resolves.toMatchObject({ title: 'Tom 1:1' })
  await expect(files.current(file)).resolves.toEqual({ title: 'Tom 1:1', cwd: null })
  expect(reads).toHaveBeenCalledTimes(3)
})

it('reports a deleted lane without trying to read it', async () => {
  const file = await lane()
  const files = new LaneFiles()
  await files.current(file)
  await unlink(file)
  await expect(files.current(file)).rejects.toBeInstanceOf(DeletedLaneError)
  await expect(files.current(file)).rejects.toMatchObject({ code: 'ENOENT', path: file })
  expect(reads).toHaveBeenCalledTimes(1)
})

it('keeps an untitled lane untitled', async () => {
  const file = await lane()
  await writeFile(file, JSON.stringify({ type: 'session', id: 'harbor-lane', cwd: '/made-up' }))
  await expect(new LaneFiles().current(file)).resolves.toMatchObject({ title: '' })
})
