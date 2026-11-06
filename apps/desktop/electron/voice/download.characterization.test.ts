import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { downloadFiles, filesPresent } from './download'

it('characterizes size-only reuse before sharing the verified transfer helper with Brain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-transfer-'))
  const file = {
    path: 'model.bin',
    url: 'https://models.invalid/model.bin',
    bytes: 4,
    sha256: createHash('sha256').update('good').digest('hex'),
  }
  const fetch = vi.fn<typeof globalThis.fetch>()
  try {
    await writeFile(join(directory, file.path), 'evil')
    expect(await filesPresent(directory, [file])).toBe(true)
    await downloadFiles(directory, [file], { fetch })
    expect(fetch).not.toHaveBeenCalled()
    expect(await readFile(join(directory, file.path), 'utf8')).toBe('evil')
    // A caller that needs activation integrity must hash existing files itself.
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
