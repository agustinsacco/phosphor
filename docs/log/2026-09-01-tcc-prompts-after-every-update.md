# macOS asked for folder permission after every update

Phosphor re-asked for Downloads, Documents and Desktop access every few days. The
prompt looked like a bug in what Phosphor reads. It was not: nothing in this repo
reads those folders by name. The bug was in how the app is signed.

## What actually happened

macOS privacy (TCC) does not store a grant against a path. It stores the app's
**designated requirement** — a code-signing predicate — and re-checks the
running app against it before honouring the grant.

The installed app's requirement was:

```
$ codesign -d -r - /Applications/Phosphor.app
# designated => cdhash H"d4594ebba2e142f2869729209bfa2d74a822034b"
```

A bare code hash. `codesign --sign -` derives that when no requirement is
given, and it changes with every build. So the moment the auto-updater swapped
the bundle, the new app no longer satisfied the requirement recorded when the
user clicked Allow, and TCC asked again — for every protected folder, on every
update. This repo releases on every green merge to main, so that was close to
daily.

Reproduced directly: sign two bundles that differ only in one resource file,
then check the second against the first's requirement.

```
$ codesign --verify -R="cdhash H\"<v1 hash>\"" v2.app
test-requirement: code failed to satisfy specified code requirement(s)
```

## The fix

[scripts/adhoc-sign-mac.mjs](../../scripts/adhoc-sign-mac.mjs) now pins the
requirement to the bundle identifier, which does not change between builds:

```
codesign --force --deep --sign - --timestamp=none \
  '-r=designated => identifier "works.phosphor.app"' Phosphor.app
```

> **Corrected 2026-09-03.** That single command does not survive nested code:
> `--deep` applies `-r` to every Helper and Framework too, and the bundle then
> fails `codesign --verify --deep --strict` with "nested code is modified or
> invalid". It failed every macOS release build until it was split into two
> passes — see
> [2026-09-03-adhoc-sign-nested-code.md](2026-09-03-adhoc-sign-nested-code.md).
> The pinned requirement itself, and everything below, still stands.

The same two-bundle experiment then passes, which is exactly the check TCC
performs after an update:

```
$ codesign --verify -R='identifier "works.phosphor.app"' v2.app   # ok
```

Two things that cost time:

- **`-r=<text>` must be inline.** Passed as two arguments (`-r`, `<text>`),
  `codesign` reads the text as a _path_ to a requirements file and fails with
  `No such file or directory / invalid requirement specification`. The first
  version of this change did exactly that; the new test caught it.
- **The build must assert the requirement, not just the signature.** A dropped
  `-r` still produces a valid, verifiable bundle — it just quietly goes back to
  a cdhash requirement and resumes nagging. The signer now runs
  `codesign --verify -R=identifier "…"` as a second check, and
  [scripts/**tests**/adhoc-sign-mac.test.ts](../../scripts/__tests__/adhoc-sign-mac.test.ts)
  builds two differing bundles and proves the second satisfies the first's
  requirement.

## What this does not do

- **It is not a security regression.** An ad-hoc signature has no anchor to
  bind a requirement to, so the old cdhash requirement bought nothing an
  attacker had to defeat: anyone able to replace the bundle in `/Applications`
  can re-sign it ad-hoc under any identifier. With a real Developer ID
  (`CSC_LINK`), electron-builder produces a stable team-anchored requirement
  and this hook does not run at all.
- **It does not remove the first prompt.** macOS still asks once per protected
  folder. `mac.extendInfo` in `electron-builder.yml` now supplies the
  `NSDesktopFolderUsageDescription` / `NSDocumentsFolderUsageDescription` /
  `NSDownloadsFolderUsageDescription` strings, so the dialog states why instead
  of demanding blindly.
- **Existing installs get one more round of prompts.** The grants currently on
  disk are keyed to the old cdhash requirement. The first build carrying this
  change re-keys them to the identifier; from then on they persist.

Whoever reads a folder is unchanged — usually the pi agent the user asked to
work somewhere, running as a child of Phosphor, which is why the prompt names
Phosphor.
