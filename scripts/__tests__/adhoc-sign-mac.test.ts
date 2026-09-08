// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import adhocSignMac from '../adhoc-sign-mac.mjs'

/**
 * The signer's job is not only "a valid signature" but "the SAME designated
 * requirement every build". `codesign --sign -` with no `-r` derives that
 * requirement from the code hash, which changes on every build; macOS privacy
 * (TCC) stores it next to each folder grant, so an auto-update silently
 * invalidated every Allow the user had clicked and the prompts came back.
 *
 * The bundle therefore carries NESTED code, as the real one does. A flat
 * bundle verifies under any combination of flags, which is why the first
 * version of these tests passed while every macOS release build failed with
 * "nested code is modified or invalid" — `-r` and `--deep` in one command
 * re-sign the nested Helper after the parent has sealed it.
 *
 * These run only on macOS — `codesign` does not exist elsewhere, and CI builds
 * the mac artifacts on a macOS runner.
 */
const APP_ID = 'works.phosphor.adhoc-sign-test'
const dirs: string[] = []

function plist(executable: string, id: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleName</key><string>${executable}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
</dict></plist>
`
}

function makeBundle(marker: string): { appOutDir: string; app: string } {
  const appOutDir = mkdtempSync(join(tmpdir(), 'phosphor-sign-test-'))
  dirs.push(appOutDir)
  const app = join(appOutDir, 'Phosphor.app')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'Info.plist'), plist('phosphor', APP_ID))
  // A real Mach-O is required; /bin/echo is the smallest one always present.
  execFileSync('/bin/cp', ['/bin/echo', join(app, 'Contents', 'MacOS', 'phosphor')])
  // Differs per build, so the two bundles get different code hashes.
  writeFileSync(join(app, 'Contents', 'Resources', 'version.txt'), marker)

  // Electron ships four Helper apps and several frameworks; one nested bundle
  // is enough to reproduce every nesting bug seen so far.
  const helper = join(app, 'Contents', 'Frameworks', 'Phosphor Helper.app')
  mkdirSync(join(helper, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(
    join(helper, 'Contents', 'Info.plist'),
    plist('Phosphor Helper', `${APP_ID}.helper`),
  )
  execFileSync('/bin/cp', ['/bin/echo', join(helper, 'Contents', 'MacOS', 'Phosphor Helper')])

  return { appOutDir, app }
}

function sign(appOutDir: string) {
  return adhocSignMac({
    electronPlatformName: 'darwin',
    appOutDir,
    packager: { appInfo: { productFilename: 'phosphor', id: APP_ID } },
  })
}

// `codesign -d` splits its report across stdout and stderr, so read both.
function inspect(app: string, ...args: string[]): string {
  const r = spawnSync('codesign', ['-d', ...args, app], { encoding: 'utf8' })
  return `${r.stdout}${r.stderr}`
}

function designatedRequirement(app: string): string {
  return inspect(app, '-r', '-')
}

function codeHash(app: string): string {
  return /^CDHash=(\S+)$/m.exec(inspect(app, '-vvv'))?.[1] ?? ''
}

describe.skipIf(process.platform !== 'darwin')('adhoc-sign-mac', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('pins the designated requirement to the bundle id, not the code hash', async () => {
    const { appOutDir, app } = makeBundle('v1')
    await sign(appOutDir)

    expect(designatedRequirement(app)).toContain(`designated => identifier "${APP_ID}"`)
    expect(designatedRequirement(app)).not.toContain('cdhash')
  })

  it('seals nested code so the bundle verifies, requirement and all', async () => {
    const { appOutDir, app } = makeBundle('v1')
    await sign(appOutDir)

    // What CI runs after packaging, and what Finder effectively runs on a
    // downloaded bundle. `-r` plus `--deep` in one pass fails here.
    expect(() =>
      execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' }),
    ).not.toThrow()
  })

  it('lets the next build satisfy the requirement TCC recorded for the last one', async () => {
    const v1 = makeBundle('v1')
    const v2 = makeBundle('v2-with-different-contents')
    await sign(v1.appOutDir)
    await sign(v2.appOutDir)

    // Different builds, as an update would be.
    expect(codeHash(v1.app)).not.toBe(codeHash(v2.app))

    // v2 still matches what macOS would have stored when the user clicked
    // Allow on v1, so the grant survives the update.
    expect(() =>
      execFileSync('codesign', ['--verify', `-R=identifier "${APP_ID}"`, v2.app], {
        stdio: 'pipe',
      }),
    ).not.toThrow()
  })

  it('leaves a Developer ID signature alone', async () => {
    const { appOutDir, app } = makeBundle('v1')
    process.env.CSC_LINK = '/tmp/not-a-real-cert.p12'
    try {
      await sign(appOutDir)
    } finally {
      delete process.env.CSC_LINK
    }
    // Nothing was re-signed, so the bundle never acquired our requirement.
    expect(designatedRequirement(app)).not.toContain(`identifier "${APP_ID}"`)
  })
})
