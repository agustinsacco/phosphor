import { beforeEach, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  access: vi.fn(),
  rename: vi.fn(),
  readdir: vi.fn(),
  trash: vi.fn(),
  repoint: vi.fn(),
}))
vi.mock('electron', () => ({ shell: { trashItem: io.trash } }))
vi.mock('node:fs/promises', () => ({ access: io.access, rename: io.rename, readdir: io.readdir }))
vi.mock('./pi/session-cwd', () => ({ repointSessionCwd: io.repoint }))
import {
  moveIfPresent,
  pathExists,
  repointTranscripts,
  trashIfPresent,
} from './sandbox-transcripts'

beforeEach(() => vi.resetAllMocks())

it('treats missing paths as absent and never moves or trashes them', async () => {
  io.access.mockRejectedValue(new Error('missing'))
  expect(await pathExists('/missing')).toBe(false)
  await moveIfPresent('/missing', '/new')
  await trashIfPresent('/missing')
  expect(io.rename).not.toHaveBeenCalled()
  expect(io.trash).not.toHaveBeenCalled()
})

it('leaves occupied destinations alone; moves only to an absent target', async () => {
  await moveIfPresent('/old', '/occupied')
  expect(io.rename).not.toHaveBeenCalled()
  io.access.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('missing'))
  await moveIfPresent('/old', '/new')
  expect(io.rename).toHaveBeenCalledWith('/old', '/new')
})

it('uses Trash for present paths and lets the caller settle failures', async () => {
  io.trash.mockRejectedValue(new Error('denied'))
  await expect(trashIfPresent('/old')).rejects.toThrow('denied')
  expect(io.trash).toHaveBeenCalledWith('/old')
})

it('isolates JSONL header failures and ignores non-JSONL files', async () => {
  io.readdir.mockResolvedValue(['a.jsonl', 'notes.txt', 'b.jsonl'])
  io.repoint.mockRejectedValueOnce(new Error('unreadable'))
  await expect(repointTranscripts('/sessions', '/old', '/new')).resolves.toBeUndefined()
  expect(io.repoint.mock.calls).toEqual([
    ['/sessions/a.jsonl', '/old', '/new'],
    ['/sessions/b.jsonl', '/old', '/new'],
  ])
})

it('ignores absent or unreadable transcript directories', async () => {
  io.readdir.mockRejectedValue(new Error('missing'))
  await repointTranscripts('/sessions', '/old', '/new')
  expect(io.repoint).not.toHaveBeenCalled()
})
