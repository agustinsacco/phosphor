import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonFile } from './json-config'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}))

describe('readJsonFile', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'phosphor-json-config-'))
    path = join(dir, 'config.json')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('reports only a missing file as absent and safe to write', async () => {
    await expect(readJsonFile(path)).resolves.toEqual({
      value: {},
      exists: false,
      malformed: false,
    })
  })

  it.each(['', '   \n\t'])('keeps whitespace-only files writable (%j)', async (raw) => {
    await fs.writeFile(path, raw)
    await expect(readJsonFile(path)).resolves.toEqual({
      value: {},
      exists: true,
      malformed: false,
    })
  })

  it('returns an object without changing nested values', async () => {
    const value = { theme: 'dark', nested: { enabled: true }, list: [1, null] }
    await fs.writeFile(path, JSON.stringify(value))
    await expect(readJsonFile(path)).resolves.toEqual({ value, exists: true, malformed: false })
  })

  it.each(['null', '[]', '[1, 2]', '"dark"', '42', 'true', 'false', '{ broken'])(
    'reports non-object or invalid JSON as malformed (%s)',
    async (raw) => {
      await fs.writeFile(path, raw)
      const result = await readJsonFile(path)
      expect(result).toMatchObject({ value: {}, exists: true, malformed: true })
      expect(result.error).toEqual(expect.any(String))
      expect(result.error).not.toBe('')
      expect(await fs.readFile(path, 'utf8')).toBe(raw)
    },
  )

  it.each(['EACCES', 'EISDIR'])(
    'reports %s read errors as malformed rather than missing',
    async (code) => {
      const error = Object.assign(new Error(`${code}: cannot read config`), { code })
      vi.spyOn(fs, 'readFile').mockRejectedValueOnce(error)
      await expect(readJsonFile(path)).resolves.toEqual({
        value: {},
        exists: true,
        malformed: true,
        error: error.message,
      })
    },
  )
})
