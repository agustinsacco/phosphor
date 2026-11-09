import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadName, localFileName, saveDownload, uniqueDownloadPath } from './downloads'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'downloads-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('download names', () => {
  it('numbers from 2, before the extension', () => {
    expect(downloadName('clip.mp4', 1)).toBe('clip.mp4')
    expect(downloadName('clip.mp4', 2)).toBe('clip (2).mp4')
    expect(downloadName('archive.tar.gz', 3)).toBe('archive.tar (3).gz')
    expect(downloadName('.env', 2)).toBe('.env (2)')
  })

  it('keeps a remote name on this file system', () => {
    expect(localFileName('a:b*c?.mp4')).toBe('a_b_c_.mp4')
    expect(localFileName('line\nbreak')).toBe('line_break')
    expect(localFileName('..')).toBe('download')
    expect(localFileName('  ')).toBe('download')
  })
})

describe('uniqueDownloadPath', () => {
  it('uses the plain name when nothing is there', async () => {
    expect(await uniqueDownloadPath(dir, 'report.pdf')).toBe(join(dir, 'report.pdf'))
  })

  it('never overwrites an earlier export', async () => {
    await writeFile(join(dir, 'report.pdf'), 'first')
    expect(await uniqueDownloadPath(dir, 'report.pdf')).toBe(join(dir, 'report (2).pdf'))
    await writeFile(join(dir, 'report (2).pdf'), 'second')
    expect(await uniqueDownloadPath(dir, 'report.pdf')).toBe(join(dir, 'report (3).pdf'))
  })
})

describe('saveDownload', () => {
  const fill = (text: string) => async (handle: FileHandle) => {
    await handle.write(Buffer.from(text), 0, text.length, 0)
  }

  it('writes through a .download part, then takes the free name', async () => {
    await writeFile(join(dir, 'clip.mp4'), 'mine')
    const saved = await saveDownload(dir, 'clip.mp4', async (handle) => {
      expect(await readdir(dir)).toContain('clip (2).mp4.download')
      await fill('new')(handle)
    })
    expect(saved).toBe(join(dir, 'clip (2).mp4'))
    expect(await readFile(join(dir, 'clip.mp4'), 'utf8')).toBe('mine')
    expect(await readFile(saved, 'utf8')).toBe('new')
    expect((await stat(saved)).mode & 0o111).toBe(0)
    expect((await readdir(dir)).sort()).toEqual(['clip (2).mp4', 'clip.mp4'])
  })

  it('never replaces a file that took the name during the download', async () => {
    const saved = await saveDownload(dir, 'clip.mp4', async (handle) => {
      await writeFile(join(dir, 'clip.mp4'), 'raced')
      await fill('new')(handle)
    })
    expect(saved).toBe(join(dir, 'clip (2).mp4'))
    expect(await readFile(join(dir, 'clip.mp4'), 'utf8')).toBe('raced')
  })

  it('creates a missing Downloads folder', async () => {
    const saved = await saveDownload(join(dir, 'Downloads'), 'a.txt', fill('a'))
    expect(saved).toBe(join(dir, 'Downloads', 'a.txt'))
  })

  it('removes the part when filling fails', async () => {
    await expect(
      saveDownload(dir, 'clip.mp4', () => Promise.reject(new Error('cancelled'))),
    ).rejects.toThrow('cancelled')
    expect(await readdir(dir)).toEqual([])
  })
})
