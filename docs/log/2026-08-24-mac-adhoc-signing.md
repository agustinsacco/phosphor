# 2026-08-24 — Every macOS release shipped a bundle Finder called "damaged"

Follow-up to [the installer 404 and updater ESM bug](2026-08-20-installer-arch-and-updater-esm.md).
That fix made the pipeline publish a complete set of artifacts. `install.sh`
now resolves and downloads correctly on macOS — verified end to end against
v0.1.90: checksum verified, mounted, copied, launched. The script was never the
problem. **The macOS bundle it installs was never signed.**

## What shipped

v0.1.90's `.dmg` and `-mac.zip` both contained:

```
Identifier=Electron
flags=0x20002(adhoc,linker-signed)
Sealed Resources=none
```

`codesign --verify --deep --strict` failed on both:

```
code has no resources but signature indicates they must be present
```

That is Electron's **stock prebuilt signature**, untouched. electron-builder
skips signing entirely without a certificate, so the binary went out exactly as
it came from the npm tarball: `Identifier=Electron`, no `_CodeSignature/`
directory, a signature claiming sealed resources that do not exist. Finder
reports that as "damaged and can't be opened" — not "unidentified developer",
which is the ordinary right-click → Open case.

Both mac artifacts were affected, so the auto-update path (`-mac.zip`) was
equally broken, not just the installer path.

## Why nothing caught it

**Dev cannot reproduce it.** `node_modules/electron/dist/Electron.app` carries
the _identical_ broken signature and fails `spctl` the same way, yet
`npm run dev` has always worked. Two reasons, and both have to hold:

1. Gatekeeper only assesses files carrying `com.apple.quarantine`. Browsers and
   `curl` set it; npm extracting a tarball does not. The dev binary is never
   flagged, so its signature is never examined.
2. The full assessment is a **LaunchServices** gate — Finder, Dock, Launchpad.
   Dev execs the binary directly from a shell, which bypasses it. Confirmed by
   deliberately quarantining the dev binary and running it from the CLI: it
   still launched.

So the failure needs a downloaded artifact opened through Finder. Dev is
neither, e2e runs unpackaged, and CI never inspected what it built.

`install.sh` also masks it: `xattr -dr com.apple.quarantine` at the end of the
mac branch strips the flag, putting the app in the same state as the dev
binary. A user who runs the script is fine. A user who downloads the DMG from
the releases page and drags it to Applications is not — same artifact,
different outcome, which is why this read as "the install script is broken".

## The fix

`scripts/adhoc-sign-mac.mjs`, wired as `afterPack`. It runs after the `.app` is
assembled and **before** the dmg/zip targets are cut, so both artifacts carry
the corrected signature from one hook.

```
Identifier=works.phosphor.app
flags=0x2(adhoc)
Sealed Resources version=2 rules=13 files=165
codesign --verify --deep --strict → passes
```

`--deep` is required: an unsealed nested Helper or Framework fails verification
of the parent. `--force` replaces the stock linker signature instead of
erroring on it.

**A dead end worth recording:** `--config.mac.identity=null` does _not_ ad-hoc
sign. electron-builder logs `skipped macOS code signing, reason=identity
explicitly is set to null` and leaves the stock signature in place — a build
with that flag produces a byte-for-byte equally broken bundle. It was tried
first and verified not to work. Only `codesign --sign -` writes the seal.

`hardenedRuntime` moved to `false`. It **requires** a real signing identity —
with an ad-hoc signature the bundle is rejected at launch. It was `true` in
config the whole time and silently inert, since nothing was signing at all.
CI passes `--config.mac.hardenedRuntime=true` back when `CSC_LINK` is set, so
notarization keeps the setting it needs.

The hook no-ops when `CSC_LINK` is present: a real Developer ID is strictly
better, electron-builder applies it itself, and re-signing ad-hoc afterwards
would strip the notarization.

## The guard

A malformed signature must fail the build that produced it. CI now runs
`codesign --verify --deep --strict` over each packaged `.app` after the
package step, and fails the job on a bad seal. It passes for both ad-hoc and
Developer ID signatures, so the guard holds regardless of whether the
certificate secrets are configured — the same reasoning as the `install.sh`
asset-name check added in the previous fix: a convention that only lives in a
comment cannot detect its own violation.

## What this does NOT fix

`spctl` still reports `rejected`, because ad-hoc means signed-by-nobody. The
first Finder launch is still right-click → Open. The change is from _malformed_
(reads as damaged, no clear user action) to _well-formed but unidentified_
(the normal macOS unsigned-app path).

**macOS self-update remains off.** `phosphorSigned=false` — confirmed by reading
the packaged `package.json` out of the shipped v0.1.90 asar — so
`canSelfInstall()` returns false and macOS takes `checkManually()`, which
detects the new version and then just opens the releases page via
`shell.openExternal`. Linux is hardcoded `SIGNED=true` in the workflow and gets
real background self-update; that asymmetry is deliberate and unchanged here.

Turning it on needs the five secrets the workflow already reads —
`MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — which require an Apple
Developer account. With those set, no code change is needed: `SIGNED=true`,
electron-builder signs and notarizes, the ad-hoc hook steps aside, hardened
runtime comes back, and macOS gets the same one-click update Linux has.

## Verification

Built `--mac dmg zip --arm64` locally with no certificate and confirmed the
hook fired automatically (`adhoc-signed and verified`) before either target was
built. Both artifacts then verified. The DMG was quarantined with a
Safari-style flag, mounted, and the app inside checked: `--verify` passes, and
`spctl` moved from `code has no resources…` to a clean `rejected`. Copied out,
quarantine stripped as `install.sh` does, launched — ran clean, no errors.

Not verified: the Developer ID path, which has no certificate available here.
Both bugs in the previous write-up were only caught by running a real packaged
build, and that caveat applies to the signed path until someone runs it.

## Addendum — debug logging (2026-08-25)

Shipped in this branch because the macOS work and a separate provider failure
were both diagnosed the same way: by hand, from evidence the app had already
seen and thrown away.

A `pi-claude-cli` session failed every turn with
`Error: Claude CLI returned success` — self-contradictory, and naming no cause.
The real reason was an API error, `Effort 'max' isn't available with thinking
turned off on this model`, triggered by `"alwaysThinkingEnabled": false` in the
user's `~/.claude/settings.json` vetoing the `--effort max` the provider sends.
Neither setting is wrong alone; they are incompatible.

The message is garbled by the provider itself: its check fires on `is_error`,
but its error template prints `subtype`, which is `"success"`. The real text
sits in `result` and is never surfaced. It was recoverable only from the CLI's
own transcript under `~/.claude/projects/`, and confirming the argv required
shimming the `claude` binary on PATH.

Phosphor kept none of this. pi's stderr was forwarded to the renderer and dropped
on unmount, and the app wrote no log at all — 4 `console.*` calls in all of
`electron/`.

`electron/debug-log.ts` now records, always-on and rotating at 5MB: session
start (versions and the inherited `PATH` — a GUI app gets launchd's, not the
login shell's), pi's spawn argv and cwd, pi's stderr, unexpected pi exits, and
main-process crashes. Env is deliberately excluded; it carries API keys.

Always-on rather than behind a flag, because a log that must be enabled first
is never on when the bug happens. It proved itself immediately: the first real
launch recorded a pre-existing unhandled rejection, a dev-mode dock icon
resolved to `out/main/build/icon-dock.png`, which does not exist. Unrelated to
this branch and left unfixed, but it had been failing silently.

Reachable from a shipped build over `app:debugLogPath` / `app:revealDebugLog`.
The procedure is in the `/debug` skill and summarised in CLAUDE.md.
