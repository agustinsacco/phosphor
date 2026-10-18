import { describe, expect, it } from 'vitest'
import * as installer from './mac-installer'
import { parseMacManifest, pickMacZip, type MacManifestFile } from './mac-manifest'

const entry = (url: string): MacManifestFile => ({ url, sha512: `${url}-hash`, size: 1 })

describe('parseMacManifest', () => {
  it('reads the version and each file url, sha512 and size', () => {
    const body = [
      'version: 2.0.0',
      'files:',
      '  - url: phosphor-2.0.0-arm64-mac.zip',
      '    sha512: ARM==',
      '    size: 171134248',
      '    blockMapSize: 180000',
      'releaseDate: 2026-10-01T00:00:00.000Z',
    ].join('\n')

    expect(parseMacManifest(body)).toEqual({
      version: '2.0.0',
      files: [{ url: 'phosphor-2.0.0-arm64-mac.zip', sha512: 'ARM==', size: 171134248 }],
    })
  })

  it('ends the files list at a column-0 key, so top-level fields stay out of it', () => {
    const body = [
      'version: 2.0.0',
      'files:',
      '  - url: a.zip',
      '    sha512: A==',
      'path: other.zip',
      'sha512: TOP==',
      'size: 99',
    ].join('\n')

    expect(parseMacManifest(body)?.files).toEqual([{ url: 'a.zip', sha512: 'A==', size: 0 }])
  })

  it('never attributes the top-level sha512 to a file that has none', () => {
    const body = ['version: 2.0.0', 'files:', '  - url: a.zip', 'sha512: TOP=='].join('\n')

    expect(parseMacManifest(body)).toBeNull()
  })

  it('keeps any indented line, tabs included, inside the open entry', () => {
    const body = 'version: 2.0.0\nfiles:\n  - url: a.zip\n\tsha512: A==\n'

    expect(parseMacManifest(body)?.files).toEqual([{ url: 'a.zip', sha512: 'A==', size: 0 }])
  })

  it('does not close the list on blank or whitespace-only lines', () => {
    const body = 'version: 2.0.0\nfiles:\n  - url: a.zip\n\n   \n    sha512: A==\n'

    expect(parseMacManifest(body)?.files).toHaveLength(1)
  })

  it('ignores items indented under any key other than files, before or after the list', () => {
    const body = [
      'version: 2.0.0',
      'before:',
      '  - url: before.zip',
      '    sha512: B==',
      'files:',
      '  - url: a.zip',
      '    sha512: A==',
      'after:',
      '  - url: after.zip',
      '    sha512: C==',
    ].join('\n')

    expect(parseMacManifest(body)?.files.map((file) => file.url)).toEqual(['a.zip'])
  })

  it('reads CRLF line endings', () => {
    const body = 'version: 2.0.0\r\nfiles:\r\n  - url: a.zip\r\n    sha512: A==\r\n    size: 5\r\n'

    expect(parseMacManifest(body)).toEqual({
      version: '2.0.0',
      files: [{ url: 'a.zip', sha512: 'A==', size: 5 }],
    })
  })

  it('strips matching single or double quotes from every scalar', () => {
    const body = [
      'version: "2.0.0"',
      'files:',
      "  - url: 'a.zip'",
      '    sha512: "A=="',
      "    size: '42'",
    ].join('\n')

    expect(parseMacManifest(body)).toEqual({
      version: '2.0.0',
      files: [{ url: 'a.zip', sha512: 'A==', size: 42 }],
    })
  })

  it('keeps unmatched or lone quotes as text', () => {
    const files = '\nfiles:\n  - url: a.zip\n    sha512: A==\n'

    expect(parseMacManifest(`version: '2.0.0"${files}`)?.version).toBe(`'2.0.0"`)
    expect(parseMacManifest(`version: '${files}`)?.version).toBe(`'`)
  })

  it('drops an entry missing its url or sha512 and keeps its siblings', () => {
    const body = [
      'version: 2.0.0',
      'files:',
      '  - url: no-hash.zip',
      '    size: 3',
      '  - sha512: NO-URL==',
      '  - url: a.zip',
      '    not a field',
      '    sha512: A==',
    ].join('\n')

    expect(parseMacManifest(body)?.files).toEqual([{ url: 'a.zip', sha512: 'A==', size: 0 }])
  })

  it.each([
    ['an empty body', ''],
    ['an HTML error page', '<html><body>404 Not Found</body></html>'],
    ['a version with no files', 'version: 2.0.0\n'],
    ['files with no version', 'files:\n  - url: a.zip\n    sha512: A==\n'],
    ['a files key with no list items', 'version: 2.0.0\nfiles:\n  url: a.zip\n  sha512: A==\n'],
    ['an indented body with no top-level keys', '  version: 2.0.0\n  files:\n'],
  ])('returns null for %s', (_label, body) => {
    expect(parseMacManifest(body)).toBeNull()
  })
})

describe('pickMacZip', () => {
  const intel = entry('phosphor-2.0.0-mac.zip')
  const arm = entry('phosphor-2.0.0-arm64-mac.zip')
  const dmgs = [entry('phosphor-2.0.0-x64.dmg'), entry('phosphor-2.0.0-arm64.dmg')]
  const blockmaps = [entry('phosphor-2.0.0-mac.zip.blockmap')]

  it('picks the Apple-silicon zip on arm64 wherever it is listed', () => {
    expect(pickMacZip([intel, arm, ...dmgs], 'arm64')).toBe(arm)
    expect(pickMacZip([arm, intel], 'arm64')).toBe(arm)
  })

  it('picks the Intel zip on x64 even when the arm64 zip comes first', () => {
    expect(pickMacZip([arm, intel], 'x64')).toBe(intel)
    expect(pickMacZip([intel, arm], 'x64')).toBe(intel)
  })

  it('considers only .zip files', () => {
    expect(pickMacZip([...dmgs, ...blockmaps], 'arm64')).toBeNull()
    expect(pickMacZip([...dmgs, ...blockmaps], 'x64')).toBeNull()
  })

  it('returns null when the release has no zip for this arch', () => {
    expect(pickMacZip([intel], 'arm64')).toBeNull()
    expect(pickMacZip([arm], 'x64')).toBeNull()
    expect(pickMacZip([], 'arm64')).toBeNull()
  })
})

describe('mac-installer facade', () => {
  it('re-exports the manifest parser unchanged', () => {
    expect(installer.parseMacManifest).toBe(parseMacManifest)
    expect(installer.pickMacZip).toBe(pickMacZip)
  })
})
