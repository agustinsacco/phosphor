# 2026-09-03 — The TCC fix broke every macOS release build: `-r` and `--deep` cannot share a pass

Reported as: "the latest release failed"
([run 33814643109](https://github.com/agustinsacco/Phosphor/actions/runs/33814643109)).

## What shipped

v0.1.174's assets: `checksums.txt`, `icon.png`, `install.sh`,
`latest-linux.yml`, `latest-linux-arm64.yml`, both `.deb`s, both `.AppImage`s.
No `.dmg`, no `.zip`, no `latest-mac.yml` — the same Linux-only release
[the August unbound-variable bug](2026-08-26-macos-continuous-release-unbound-variable.md)
produced, from a different cause.

v0.1.172 is the first release missing them. v0.1.170 still had both `.dmg`s.

## Root cause

`Build and publish macOS` failed inside `electron-builder`'s `afterPack` hook:

```
release/mac-arm64/Phosphor.app: replacing existing signature
release/mac-arm64/Phosphor.app: nested code is modified or invalid
  ⨯ Command failed: codesign --verify --deep --strict …/Phosphor.app
    at adhocSignMac (scripts/adhoc-sign-mac.mjs:75:3)
```

The hook signed and then verified its own work, and its own verification
failed. The signing command was the one
[the TCC fix](2026-09-01-tcc-prompts-after-every-update.md) (#156, `0609426`)
introduced — a single pass carrying both `--deep` and the pinned requirement:

```sh
codesign --force --deep --sign - --timestamp=none \
  '-r=designated => identifier "works.phosphor.app"' Phosphor.app
```

`--deep` applies `-r` to every nested Helper and Framework as well. Re-signing
those after the enclosing bundle has sealed them leaves the parent sealing a
binary that no longer matches. `--verbose=4` names it:

```
file modified: …/Electron Framework.framework/Versions/Current/Helpers/chrome_crashpad_handler
```

Reproduced on macOS 26.6.2 — the same version the `macos-26-arm64` runner image
runs — against `node_modules/electron/dist/Electron.app`: the one-pass command
fails `--verify --deep --strict` every time, and dropping `-r` from it passes
every time. That is the whole difference; nothing about the runner changed.

#156 shipped 2026-09-03 08:28 and every macOS release build since has failed.

## Why nothing caught it

`scripts/__tests__/adhoc-sign-mac.test.ts` came with #156 and passed. Its
fixture was a **flat** bundle: an `Info.plist`, one Mach-O, one resource file,
no `Contents/Frameworks`. With no nested code, `--deep` has nothing to descend
into and `-r` has nothing extra to apply itself to, so the bug it was written
alongside could not appear. The test asserted the requirement was pinned — the
thing #156 set out to do — and never asserted the bundle still verified.

CI's own `Verify the macOS bundle signature` step would have caught it, but the
hook fails the build first, several steps earlier.

`fail-fast: false` on the build matrix plus `finalize`'s `!cancelled()` gate
meant the Linux job's success alone still published a release, so the pipeline
stayed green-ish and the only signal was a red macOS job inside a successful
run — the identical blind spot the August write-up ends on.

## The fix

Two passes. Seal nested code first with no requirement of our own, then
re-sign only the outer bundle with `-r`:

```sh
codesign --force --deep --sign - --timestamp=none Phosphor.app
codesign --force --sign - --timestamp=none \
  '-r=designated => identifier "works.phosphor.app"' Phosphor.app
```

Signing outside-in is what Apple asks for anyway: the outer signature seals the
already-signed nested code by hash, so the second pass recomputes those seals
rather than invalidating them. Nested code keeps a per-build cdhash
requirement, which is what it had before #156 — TCC only ever consults the
app's own requirement, so #156's actual goal is unaffected.

Verified against a real `Electron.app` on macOS 26.6.2 and against a full
`electron-builder --mac dmg --arm64` run:

```
Identifier=works.phosphor.app
flags=0x2(adhoc)
designated => identifier "works.phosphor.app"
codesign --verify --deep --strict          → ok
codesign --verify -R='identifier "works.phosphor.app"' → ok
```

## The guard

The test fixture now nests a `Phosphor Helper.app` under `Contents/Frameworks`, as
the real bundle does, and a new case runs the same
`codesign --verify --deep --strict` CI runs. Against the shipped signer three
of the four cases fail with the CI error; against the fix all four pass. One
nested bundle is enough — the failure does not need Electron's four Helpers and
five frameworks to appear.

That suite is `skipIf(platform !== 'darwin')`, because `codesign` exists
nowhere else, and CI's unit-test job runs on `ubuntu-latest` — so **CI never
executed it once**. It ran on whoever last opened the file on a Mac. The
macOS e2e job is the only macOS runner in CI, so it now runs this suite too,
after its build step; the whole file takes well under a second.

## What this does not fix

It does not add mac assets to v0.1.172 or v0.1.174. The next green merge to
`main` publishes the next release with them restored.

Nothing here closes the reporting gap either: a macOS-only failure still
publishes a Linux-only release and still shows up only as a red job inside a
run GitHub calls successful. Both macOS release regressions so far were found
by someone noticing a missing `.dmg`.
