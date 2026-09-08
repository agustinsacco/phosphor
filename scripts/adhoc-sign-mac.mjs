/**
 * `afterPack` hook: ad-hoc sign the macOS bundle when there is no Developer ID.
 *
 * Electron's prebuilt binary ships `linker-signed` with `Identifier=Electron`
 * and NO sealed resources. When electron-builder has no certificate it skips
 * signing entirely (`identity=null` skips it too — it does not ad-hoc sign),
 * so that stock signature is what shipped: v0.1.90's `.dmg` and `-mac.zip`
 * both failed `codesign --verify` with
 *
 *     code has no resources but signature indicates they must be present
 *
 * which Finder reports as "damaged and can't be opened". Dev never caught it
 * because `npm run dev` execs the binary directly — Gatekeeper only assesses
 * files carrying `com.apple.quarantine`, which a download has and an npm
 * tarball does not.
 *
 * `codesign --sign -` re-signs the bundle properly: identifier becomes
 * `works.phosphor.app` and the resource seal is written, so the bundle verifies.
 * It is still ad-hoc — `spctl` says `rejected` rather than accepting it — but
 * "unsigned by anyone" is a normal right-click → Open, not a damaged app.
 *
 * Runs BEFORE the dmg/zip targets are cut, so both artifacts carry the fixed
 * signature. A no-op when a real certificate is present: electron-builder has
 * already signed and notarized by then, and re-signing ad-hoc would strip that.
 *
 * ## Why it pins an explicit designated requirement
 *
 * Left to itself, `codesign --sign -` derives the designated requirement from
 * the code hash: `designated => cdhash H"…"`. That hash changes with every
 * build. macOS privacy (TCC) stores that requirement alongside each grant and
 * re-checks it on the next launch, so after an auto-update the installed app
 * no longer satisfies the requirement recorded when the user clicked Allow —
 * and every folder prompt (Downloads, Documents, Desktop, …) comes back. This
 * repo ships a release on every green merge to main, so in practice the app
 * asked again more or less daily.
 *
 * `-r 'designated => identifier "<appId>"'` pins the requirement to the bundle
 * identifier instead, which is stable across builds, so a grant survives the
 * update. This does not weaken anything meaningful: an ad-hoc signature has no
 * anchor to bind to in the first place, and anyone able to replace the bundle
 * in /Applications can already re-sign it ad-hoc under any identifier. A real
 * Developer ID (the CSC_LINK path above) gets a stable team-anchored
 * requirement from electron-builder and never reaches this code.
 *
 * ## Why the requirement needs its OWN pass
 *
 * `-r` and `--deep` in one command produce a bundle that does not verify:
 *
 *     codesign --verify --deep --strict Phosphor.app
 *     Phosphor.app: nested code is modified or invalid
 *
 * `--deep` applies the requirement to every nested Helper and Framework as
 * well, and re-signing them after the enclosing seal was computed leaves the
 * parent sealing a binary that no longer matches (`file modified:
 * …/Electron Framework.framework/Versions/Current/Helpers/chrome_crashpad_handler`).
 * Shipped as one command in #156, it failed 100% of macOS release builds —
 * v0.1.172 and v0.1.174 both published Linux-only, no `.dmg`, no
 * `latest-mac.yml`.
 *
 * So: seal nested code first with no requirement of our own, then re-sign only
 * the OUTER bundle with `-r`. Signing outside-in is what Apple asks for anyway
 * — the outer signature seals the (already signed) nested code by hash, so the
 * second pass recomputes those seals rather than invalidating them. Nested
 * code keeps a per-build cdhash requirement, which is what it had before #156
 * and what TCC never looks at; only the app's own requirement is consulted.
 */
import { execFileSync } from 'node:child_process'

export default async function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return

  // A real Developer ID is strictly better and electron-builder applies it
  // itself; never clobber that signature with an ad-hoc one.
  if (process.env.CSC_LINK) {
    console.log('  • adhoc-sign skipped — CSC_LINK present, electron-builder signs')
    return
  }

  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  const appId = context.packager.appInfo.id
  // `-r=<text>` inline, NOT `-r <text>`: given a separate argument codesign
  // reads it as a PATH to a requirements file and dies with
  // "No such file or directory / invalid requirement specification".
  const requirement = `-r=designated => identifier "${appId}"`

  // Pass 1 — nested code. --deep so nested Helpers and Frameworks are sealed
  // too; an unsealed nested bundle fails verification of the parent. --force
  // replaces the stock linker signature rather than erroring on it. No `-r`
  // here: see "Why the requirement needs its OWN pass" above.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], {
    stdio: 'inherit',
  })

  // Pass 2 — the outer bundle only, this time carrying the pinned requirement.
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', requirement, app], {
    stdio: 'inherit',
  })

  // Verify here, not in a later job: a broken signature must fail the build
  // that produced it, not surface as a "damaged app" on a user's Mac.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })

  // The whole point of the -r above is that the NEXT build still satisfies
  // this requirement, so assert the bundle matches it by identifier alone —
  // a silently-dropped -r would otherwise ship as a cdhash requirement again
  // and quietly resume nagging the user after every update.
  execFileSync('codesign', ['--verify', `-R=identifier "${appId}"`, app], { stdio: 'inherit' })

  console.log(`  • adhoc-signed ${app} (designated requirement: identifier "${appId}")`)
}
