import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bundlePathFromExe,
  isOrphanedUpdateEntry,
  isTranslocated,
  parseMacManifest,
  pickMacZip,
  swapBundle,
  sweepOrphans,
} from './mac-installer'

const scratch: string[] = []

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'phosphor-installer-test-'))
  scratch.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Verbatim shape of a published latest-mac.yml (v0.1.115, truncated hashes). */
const MANIFEST = `version: 0.1.115
files:
  - url: phosphor-0.1.115-mac.zip
    sha512: X64ZIP==
    size: 175684593
  - url: phosphor-0.1.115-arm64-mac.zip
    sha512: ARM64ZIP==
    size: 171134248
  - url: phosphor-0.1.115-x64.dmg
    sha512: X64DMG==
    size: 175482497
  - url: phosphor-0.1.115-arm64.dmg
    sha512: ARM64DMG==
    size: 170945424
path: phosphor-0.1.115-mac.zip
sha512: X64ZIP==
releaseDate: '2026-08-27T21:03:42.057Z'
`

describe('parseMacManifest', () => {
  it('reads the version and every file entry', () => {
    const manifest = parseMacManifest(MANIFEST)
    expect(manifest?.version).toBe('0.1.115')
    expect(manifest?.files).toHaveLength(4)
    expect(manifest?.files[1]).toEqual({
      url: 'phosphor-0.1.115-arm64-mac.zip',
      sha512: 'ARM64ZIP==',
      size: 171134248,
    })
  })

  it('does not let the trailing top-level sha512 leak into the last file', () => {
    // The manifest repeats `path:`/`sha512:` at column 0 after the list. A
    // parser that keyed on the field name alone would overwrite the .dmg entry
    // with the x64 zip's hash, and every download would then fail its check.
    const manifest = parseMacManifest(MANIFEST)
    expect(manifest?.files.at(-1)).toEqual({
      url: 'phosphor-0.1.115-arm64.dmg',
      sha512: 'ARM64DMG==',
      size: 170945424,
    })
  })

  it('strips quotes from quoted scalars', () => {
    const manifest = parseMacManifest("version: '1.2.3'\nfiles:\n  - url: a.zip\n    sha512: h\n")
    expect(manifest?.version).toBe('1.2.3')
  })

  it('returns null for a manifest with no files', () => {
    expect(parseMacManifest('version: 1.0.0\n')).toBeNull()
  })

  it('returns null for junk', () => {
    expect(parseMacManifest('<html>404</html>')).toBeNull()
  })
})

describe('pickMacZip', () => {
  const files = parseMacManifest(MANIFEST)?.files ?? []

  it('picks the arm64 zip on Apple silicon', () => {
    expect(pickMacZip(files, 'arm64')?.url).toBe('phosphor-0.1.115-arm64-mac.zip')
  })

  it('picks the Intel zip on x64', () => {
    // The x64 entry is listed FIRST and is what the manifest's top-level
    // `path:` points at, so an arch-blind "first zip wins" passes this and
    // fails the arm64 case above. Both directions are the test.
    expect(pickMacZip(files, 'x64')?.url).toBe('phosphor-0.1.115-mac.zip')
  })

  it('never returns a dmg', () => {
    const dmgOnly = files.filter((file) => file.url.endsWith('.dmg'))
    expect(pickMacZip(dmgOnly, 'arm64')).toBeNull()
    expect(pickMacZip(dmgOnly, 'x64')).toBeNull()
  })

  it('returns null on arm64 when the release shipped Intel only', () => {
    const intelOnly = files.filter((file) => file.url === 'phosphor-0.1.115-mac.zip')
    expect(pickMacZip(intelOnly, 'arm64')).toBeNull()
  })
})

describe('bundlePathFromExe', () => {
  it('walks up from the executable to the .app root', () => {
    expect(bundlePathFromExe('/Applications/Phosphor.app/Contents/MacOS/phosphor')).toBe(
      '/Applications/Phosphor.app',
    )
  })

  it('rejects an unpackaged dev binary', () => {
    expect(bundlePathFromExe('/repo/node_modules/electron/dist/electron')).toBeNull()
  })

  it('rejects a path that is three deep but not a bundle', () => {
    expect(bundlePathFromExe('/opt/tools/Contents/MacOS/phosphor')).toBeNull()
  })
})

describe('isTranslocated', () => {
  it('detects a Gatekeeper-translocated bundle', () => {
    expect(
      isTranslocated('/private/var/folders/ab/xyz/d/AppTranslocation/1234-ABCD/d/Phosphor.app'),
    ).toBe(true)
  })

  it('accepts a normal install', () => {
    expect(isTranslocated('/Applications/Phosphor.app')).toBe(false)
  })
})

describe('isOrphanedUpdateEntry', () => {
  it('matches what staging and backup actually produce', () => {
    expect(isOrphanedUpdateEntry('.phosphor-update-4821-1756330000000')).toBe(true)
    expect(isOrphanedUpdateEntry('.phosphor-old-4821-1756330000000.app')).toBe(true)
    // Leftovers from the last pre-rename (pidex) build, which staged the very
    // release that renamed the app — only the new build's sweep sees them.
    expect(isOrphanedUpdateEntry('.pidex-update-4821-1756330000000')).toBe(true)
    expect(isOrphanedUpdateEntry('.pidex-old-4821-1756330000000.app')).toBe(true)
  })

  it('leaves anything else alone', () => {
    // This guard is what stands between the sweep and `rm -rf` on a user's
    // own file, so a bare prefix must not be enough to match.
    expect(isOrphanedUpdateEntry('Phosphor.app')).toBe(false)
    expect(isOrphanedUpdateEntry('.phosphor-old-notes')).toBe(false)
    expect(isOrphanedUpdateEntry('.phosphor-update-')).toBe(false)
    expect(isOrphanedUpdateEntry('.phosphor-update-1756330000000')).toBe(false)
    expect(isOrphanedUpdateEntry('..phosphor-old-1-2.app')).toBe(false)
  })
})

/**
 * The swap is the only code in Phosphor that replaces something in /Applications,
 * so both directions are tested against a real filesystem rather than a mock:
 * a rename that silently no-ops in a fake would pass a mocked test and lose a
 * user their app.
 */
describe('swapBundle', () => {
  it('puts the staged bundle in place and reports a restorable backup', async () => {
    const parent = await sandbox()
    const bundle = join(parent, 'Phosphor.app')
    const stagingDir = join(parent, '.phosphor-update-1-2')
    const stagedBundle = join(stagingDir, 'Phosphor.app')
    await mkdir(bundle, { recursive: true })
    await writeFile(join(bundle, 'marker'), 'old')
    await mkdir(stagedBundle, { recursive: true })
    await writeFile(join(stagedBundle, 'marker'), 'new')

    const backup = await swapBundle(bundle, { version: '9.9.9', stagedBundle, stagingDir })

    expect(existsSync(join(bundle, 'marker'))).toBe(true)
    await expect(readFileText(join(bundle, 'marker'))).resolves.toBe('new')
    // The backup survives for the relauncher to delete once we have exited.
    expect(existsSync(join(backup, 'marker'))).toBe(true)
    // Staging is gone, so the next sweep has nothing to find.
    expect(existsSync(stagingDir)).toBe(false)
  })

  it('restores the original when the second rename fails', async () => {
    // The case worth designing for: the alternative to a rollback is a user
    // with no Phosphor at all.
    const parent = await sandbox()
    const bundle = join(parent, 'Phosphor.app')
    await mkdir(bundle, { recursive: true })
    await writeFile(join(bundle, 'marker'), 'old')

    const missing = join(parent, '.phosphor-update-1-2', 'Phosphor.app')
    await expect(
      swapBundle(bundle, {
        version: '9.9.9',
        stagedBundle: missing,
        stagingDir: join(parent, '.phosphor-update-1-2'),
      }),
    ).rejects.toThrow()

    await expect(readFileText(join(bundle, 'marker'))).resolves.toBe('old')
  })
})

describe('sweepOrphans', () => {
  it('removes leftovers and nothing else', async () => {
    const parent = await sandbox()
    const bundle = join(parent, 'Phosphor.app')
    for (const name of [
      'Phosphor.app',
      '.phosphor-update-11-22',
      '.phosphor-old-11-22.app',
      '.phosphor-old-notes',
      'Safari.app',
    ]) {
      await mkdir(join(parent, name), { recursive: true })
    }

    const removed = await sweepOrphans(bundle)

    expect(removed).toHaveLength(2)
    expect((await readdir(parent)).sort()).toEqual([
      '.phosphor-old-notes',
      'Phosphor.app',
      'Safari.app',
    ])
  })

  it('is a no-op when the parent cannot be read', async () => {
    await expect(sweepOrphans('/nope/does-not-exist/Phosphor.app')).resolves.toEqual([])
  })
})

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}
