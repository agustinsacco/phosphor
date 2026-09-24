import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const openPath = vi.fn(async (_path: string) => '')
vi.mock('electron', () => ({ shell: { openPath: (path: string) => openPath(path) } }))

const { launchRefusal, openInDefaultApp } = await import('./open-file')

const regular = { isFile: true, mode: 0o100644 }
const launchable = { ok: false, reason: 'launchable' }

describe('launchRefusal', () => {
  it.each(['report.docx', 'sheet.xlsx', 'deck.key', 'archive.zip', 'image.heic', 'Makefile'])(
    'allows %s',
    (name) => {
      expect(launchRefusal(`/w/${name}`, regular, 'darwin')).toBeNull()
    },
  )

  it.each([
    'install.command',
    'setup.pkg',
    'run.sh',
    'tool.py',
    'Setup.exe',
    'script.JS', // case-insensitive
    'link.webloc',
    'app.AppImage',
  ])('refuses %s, which the OS would run', (name) => {
    expect(launchRefusal(`/w/${name}`, regular, 'darwin')).toEqual(launchable)
  })

  it('refuses anything with an execute bit outside Windows', () => {
    const executable = { isFile: true, mode: 0o100755 }
    expect(launchRefusal('/w/binary', executable, 'darwin')).toEqual(launchable)
    expect(launchRefusal('/w/data.bin', { isFile: true, mode: 0o100744 }, 'linux')).toEqual(
      launchable,
    )
    // NTFS reports no meaningful mode bits; the extension list is the guard.
    expect(launchRefusal('C:\\w\\report.docx', executable, 'win32')).toBeNull()
  })

  it('refuses a non-file', () => {
    expect(launchRefusal('/w/folder', { isFile: false, mode: 0o40755 }, 'darwin')).toEqual({
      ok: false,
      reason: 'not-a-file',
    })
  })
})

describe('openInDefaultApp', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phosphor-open-file-'))
    await writeFile(join(dir, 'report.docx'), 'x')
    await writeFile(join(dir, 'run'), '#!/bin/sh\necho hi\n')
    await chmod(join(dir, 'run'), 0o755)
    await symlink(join(dir, 'run'), join(dir, 'looks-harmless.docx'))
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))
  beforeEach(() => openPath.mockClear())

  it('hands a document to the OS', async () => {
    expect(await openInDefaultApp(join(dir, 'report.docx'))).toEqual({ ok: true })
    expect(openPath).toHaveBeenCalledWith(join(dir, 'report.docx'))
  })

  it.skipIf(process.platform === 'win32')('never hands over an executable', async () => {
    expect(await openInDefaultApp(join(dir, 'run'))).toEqual(launchable)
    expect(openPath).not.toHaveBeenCalled()
  })

  it('does not follow a symlink to whatever it points at', async () => {
    expect((await openInDefaultApp(join(dir, 'looks-harmless.docx'))).ok).toBe(false)
    expect(openPath).not.toHaveBeenCalled()
  })

  it('reports a missing file and an OS failure', async () => {
    expect(await openInDefaultApp(join(dir, 'missing.docx'))).toEqual({
      ok: false,
      reason: 'not-a-file',
    })
    openPath.mockResolvedValueOnce('No application knows how to open this')
    expect(await openInDefaultApp(join(dir, 'report.docx'))).toEqual({
      ok: false,
      reason: 'failed',
      message: 'No application knows how to open this',
    })
  })
})
