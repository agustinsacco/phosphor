# 2026-08-20 — The installer 404'd, and self-update had never once run

Follow-up to [releases that actually ship](2026-08-20-releases-and-linux-window.md).
That fix made the release pipeline publish a complete set of artifacts; v0.1.48
has every manifest, both platforms, both arches, and `checksums.txt`. Two
independent bugs still stood between a user and a working install.

## 1. `install.sh` asked for a filename that never existed

`curl … install.sh | sh` on x86_64 Linux died with:

```
==> Downloading Phosphor-0.1.48-x64.AppImage (v0.1.48)…
curl: (22) The requested URL returned error: 404
```

The script normalized `uname -m` to a single `ARCH` (`x86_64` → `x64`) and used
it for every target. But **electron-builder expands `${arch}` per TARGET, not
per machine**: the same x64 build ships as `-x64.dmg`, `-x86_64.AppImage` and
`-amd64.deb`. One normalized token cannot address all three, so the Linux path
requested an asset that was never built. The comment in `electron-builder.yml`
("install.sh downloads exactly this name — keep the two in sync") was a
convention with nothing enforcing it, and the two drifted the moment the
AppImage target started building.

`APPIMAGE_ARCH` now carries the AppImage spelling alongside `ARCH`. Verified by
running the fixed script end to end against the live release: it downloaded
`Phosphor-0.1.48-x86_64.AppImage`, printed **Checksum verified** (the
`checksums.txt` added in the previous change), installed the binary, wrote the
desktop entry and icon, and found `pi` on PATH.

**Guard added**, because a comment already failed at this once: the release
workflow now asks what names `install.sh` would build and fails the run if the
release does not contain them. A convention that only lives in a comment cannot
detect its own violation.

## 2. `autoUpdater` was `undefined` in every packaged build

Running the installed AppImage surfaced this on the first check:

```
UnhandledPromiseRejectionWarning: TypeError:
  Cannot set properties of undefined (setting 'autoDownload')
    at wireUpdaterEvents (…/app.asar/out/main/main.js:2837)
```

`electron-updater` is CommonJS; the packaged main bundle is ESM
(`"type": "module"`). Its exports therefore arrive under `.default`, and
`const { autoUpdater } = await import('electron-updater')` yields **undefined** —
Node's lexer lists `autoUpdater` among the namespace keys, but the value is a
lazy getter that only exists on the CJS exports object. Confirmed directly:

```
namespace keys: [ …, 'DebUpdater', 'MacUpdater', 'NoOpLogger' ]
m.autoUpdater:         undefined
m.default.autoUpdater: (present)
```

This dates to `60061ee` (#14), the commit that introduced auto-update — so the
self-installing path **has never worked**, on any release, independent of the
pipeline breakage that was masking it. Dev never caught it because this module
short-circuits on `!app.isPackaged`, and the e2e suite runs unpackaged for the
same reason.

Fixed with an `importUpdater()` interop helper used by all three call sites.
`startUpdateChecks`'s init IIFE also gained a `.catch` — an unguarded rejection
there surfaced as a raw warning instead of the silent degrade this module
promises everywhere else.

**Verified against a real packaged build**, not a reasoned argument: an AppImage
built exactly as CI builds it (`--config.extraMetadata.phosphorSigned=true`,
version pinned to `0.1.40`) and run against the live v0.1.48 release. Zero
TypeErrors, zero unhandled rejections, and the sidebar rendered
**"Restart to update"** — the first time the pill has ever appeared.

## Testing note

Reproducing either bug requires a _packaged_ build; both paths are disabled in
dev and under Playwright. Building an AppImage with the CI flags and running it
headfully is the only thing that exercises them, and it is what caught both.
