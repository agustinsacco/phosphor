import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readLaneEntries } from './transcript'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-archive-'))
  directories.push(directory)
  return { directory, file: join(directory, 'harbor.jsonl') }
}

it('prefers the stored transcript when both it and the archived twin exist', async () => {
  const { file } = await setup()
  await writeFile(file, JSON.stringify({ id: 'original' }))
  await writeFile(`${file}.archived`, JSON.stringify({ id: 'parked' }))
  expect(await readLaneEntries(file)).toEqual([{ id: 'original' }])
})

it('does not search for a renamed transcript or append the archived suffix twice', async () => {
  const { directory, file } = await setup()
  await writeFile(join(directory, 'ledger.jsonl.archived'), JSON.stringify({ id: 'other' }))
  await writeFile(`${file}.archived.archived`, JSON.stringify({ id: 'nested' }))
  await expect(readLaneEntries(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not hide a read error by using the archived twin', async () => {
  const { file } = await setup()
  await mkdir(file)
  await writeFile(`${file}.archived`, JSON.stringify({ id: 'parked' }))
  await expect(readLaneEntries(file)).rejects.toMatchObject({ code: 'EISDIR' })
})

it('reports a lane with neither transcript as deleted, keeping ENOENT for missing-file checks', async () => {
  const { file } = await setup()
  await expect(readLaneEntries(file)).rejects.toMatchObject({
    message: "This lane was deleted, so Brain can't read it.",
    code: 'ENOENT',
    path: file,
  })
})
