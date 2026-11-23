import { afterEach, beforeEach, expect, it } from 'vitest'
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { archiveIdFor, createLaneArchiveStorage } from './storage'

let root: string
let sessions: string
let file: string
let cwd: string
let id: string
let storage: ReturnType<typeof createLaneArchiveStorage>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'phosphor-archive-'))
  sessions = join(root, 'sessions')
  cwd = join(root, 'worktree')
  file = join(sessions, 'cwd', '2026_a.jsonl')
  await mkdir(join(sessions, 'cwd'), { recursive: true })
  await mkdir(cwd)
  await writeFile(file, 'conversation\n')
  await writeFile(join(cwd, '.env'), 'private ignored content')
  id = archiveIdFor(file)
  storage = createLaneArchiveStorage(join(root, 'archive'), sessions)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const prepare = () => storage.prepare({ id, cwd, title: 'Keep my work', transcript: file })

it('archives without touching worktree files and restores after restart', async () => {
  await prepare()
  expect((await storage.list()).entries[0]?.state).toBe('archiving')
  await storage.archive(id)
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(`${file}.archived`, 'utf8')).toBe('conversation\n')
  expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('private ignored content')
  storage = createLaneArchiveStorage(join(root, 'archive'), sessions)
  await storage.restore(id)
  expect((await storage.get(id)).state).toBe('restoring')
  expect(await readFile(file, 'utf8')).toBe('conversation\n')
  await storage.finish(id)
  expect((await storage.list()).entries).toEqual([])
})

it('retries a crash between linking and unlinking without losing either copy', async () => {
  await prepare()
  await link(file, `${file}.archived`)
  await storage.archive(id)
  await storage.archive(id)
  await link(`${file}.archived`, file)
  await storage.restore(id)
  await storage.restore(id)
  expect(await readFile(file, 'utf8')).toBe('conversation\n')
})

it('never overwrites a replacement file on restore', async () => {
  await prepare()
  await storage.archive(id)
  await writeFile(file, 'different conversation')
  await expect(storage.restore(id)).rejects.toThrow('Nothing was overwritten')
  expect(await readFile(file, 'utf8')).toBe('different conversation')
  expect(await readFile(`${file}.archived`, 'utf8')).toBe('conversation\n')
})

it('does not claim restore succeeded when the archive is missing and source was replaced', async () => {
  await prepare()
  await storage.archive(id)
  await writeFile(file, 'replacement')
  await rm(`${file}.archived`)
  await expect(storage.restore(id)).rejects.toThrow('missing or has been replaced')
})

it('keeps purge intent and transcript when worktree cleanup fails, then permits retry', async () => {
  await prepare()
  await storage.archive(id)
  const runs = file.slice(0, -6)
  await mkdir(runs)
  await writeFile(join(runs, 'child.txt'), 'child history')
  const shared = join(sessions, 'cwd', 'subagent-artifacts')
  await mkdir(shared)
  await writeFile(join(shared, 'other-lane.txt'), 'not ours')
  await expect(
    storage.purge(id, async () => {
      throw new Error('worktree busy')
    }),
  ).rejects.toThrow('busy')
  expect((await storage.get(id)).state).toBe('purging')
  expect(await readFile(`${file}.archived`, 'utf8')).toBe('conversation\n')
  await expect(storage.restore(id)).rejects.toThrow('Cleanup has started')
  await storage.purge(id, async () => {})
  await storage.purge(id, async () => {})
  await expect(stat(runs)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(shared, 'other-lane.txt'), 'utf8')).toBe('not ours')
  await storage.finish(id)
})

it('refuses non-session paths and symlinked session files', async () => {
  await expect(
    storage.prepare({ id, cwd, title: 'invalid', transcript: join(cwd, 'a.jsonl') }),
  ).rejects.toThrow()
  await rm(file)
  await writeFile(join(cwd, 'a.jsonl'), 'outside')
  await symlink(join(cwd, 'a.jsonl'), file)
  await expect(prepare()).rejects.toThrow('regular session')
})

it('retries cleanup after the adapter removed the entire session folder', async () => {
  await prepare()
  await storage.archive(id)
  await expect(
    storage.purge(id, async () => {
      await rm(join(sessions, 'cwd'), { recursive: true })
      throw new Error('interrupted after transcript cleanup')
    }),
  ).rejects.toThrow('interrupted')
  expect((await storage.get(id)).state).toBe('purging')
  await expect(storage.purge(id, async () => {})).resolves.toBeUndefined()
  await storage.finish(id)
  expect((await storage.list()).entries).toEqual([])
})

it('keeps empty lanes recoverable without inventing a transcript', async () => {
  await storage.prepare({ id, cwd, title: 'No first message yet' })
  await storage.archive(id)
  const record = await storage.restore(id)
  expect(record.transcript).toBeUndefined()
  expect(record.cwd).toBe(cwd)
})

it('lets an empty lane interrupted mid-restore be cleaned up, but not a restored conversation', async () => {
  const empty = archiveIdFor('empty:lane')
  await storage.prepare({ id: empty, cwd, title: 'No first message yet' })
  await storage.archive(empty)
  await storage.restore(empty)
  await storage.purge(empty, async () => {})
  await storage.finish(empty)
  await prepare()
  await storage.archive(id)
  await storage.restore(id)
  await expect(storage.purge(id, async () => {})).rejects.toThrow('Restore this incomplete archive')
})

it('archives a worktree lane whose checkout is already gone, without a checkout identity', async () => {
  await rm(cwd, { recursive: true })
  const record = await storage.prepare({
    id,
    cwd,
    title: 'Removed outside Phosphor',
    worktree: true,
  })
  expect(record.checkout).toBeUndefined()
  await storage.archive(id)
  await storage.purge(id, async () => {})
})

it('adopts a record another runtime archived, as written, and refuses its id for another lane', async () => {
  await prepare()
  await storage.archive(id)
  const record = await storage.get(id)
  await storage.finish(id)
  const adopted = {
    ...record,
    id: '0b6a3c3e-5d0e-4c55-9f61-6a1f6c1d9e10',
    metadata: { repositoryId: 'a' },
  }
  await storage.adopt(adopted)
  expect(await storage.get(adopted.id)).toEqual(adopted)
  expect(await readFile(`${file}.archived`, 'utf8')).toBe('conversation\n')
  await storage.adopt(adopted)
  await expect(storage.adopt({ ...adopted, cwd: join(root, 'other') })).rejects.toThrow(
    'This archive ID already belongs to a different lane.',
  )
  await expect(
    storage.adopt({ ...adopted, transcript: join(sessions, 'cwd', '2026_b.jsonl') }),
  ).rejects.toThrow('This archive ID already belongs to a different lane.')
})
