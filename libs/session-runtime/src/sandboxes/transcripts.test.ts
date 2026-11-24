import { beforeEach, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  access: vi.fn(),
  rename: vi.fn(),
  readdir: vi.fn(),
  trash: vi.fn(),
  repoint: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({ access: io.access, rename: io.rename, readdir: io.readdir }))
vi.mock('../pi/session-cwd', () => ({ repointSessionCwd: io.repoint }))
import { moveIfPresent, pathExists, repointTranscripts, trashIfPresent } from './transcripts'

beforeEach(() => vi.resetAllMocks())

it('treats missing paths as absent and never moves or trashes them', async () => {
  io.access.mockRejectedValue(new Error('missing'))
  expect(await pathExists('/missing')).toBe(false)
  await moveIfPresent('/missing', '/new')
  await trashIfPresent('/missing', io.trash)
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
  await expect(trashIfPresent('/old', io.trash)).rejects.toThrow('denied')
  expect(io.trash).toHaveBeenCalledWith('/old')
})

it('isolates JSONL header failures and ignores non-JSONL files', async () => {
  io.readdir.mockResolvedValue(['a.jsonl', 'notes.txt', 'b.jsonl'])
  io.repoint.mockRejectedValueOnce(new Error('unreadable'))
  await expect(repointTranscripts('/sessions', '/old', '/new', '/pi')).resolves.toBeUndefined()
  expect(io.repoint.mock.calls).toEqual([
    ['/sessions/a.jsonl', '/old', '/new', '/pi'],
    ['/sessions/b.jsonl', '/old', '/new', '/pi'],
  ])
})

it('ignores absent or unreadable transcript directories', async () => {
  io.readdir.mockRejectedValue(new Error('missing'))
  await repointTranscripts('/sessions', '/old', '/new')
  expect(io.repoint).not.toHaveBeenCalled()
})
