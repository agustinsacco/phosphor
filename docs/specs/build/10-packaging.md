# 10 — Packaging, Install, CI

## Builds

- electron-builder targets:
  - macOS: dmg + zip, arm64 + x64 (universal acceptable), hardened runtime; sign+notarize when creds present, unsigned dev builds otherwise.
  - Linux: AppImage + deb, x64 + arm64.
  - Windows: nsis x64.
- Native deps to handle in build config: node-pty (electron-rebuild / prebuilds per platform).
- App icon + branding assets per [00-overview.md](../../overview.md).

## Install via curl

- `scripts/install.sh` published with releases and served at a stable URL:
  `curl -fsSL <releases-url>/install.sh | sh`
  - Detects OS/arch → downloads the matching artifact from the latest GitHub Release → installs (macOS: mount dmg or unzip → /Applications; Linux: AppImage to ~/.local/bin + .desktop entry).
  - Verifies checksum (checksums.txt in the release).
  - Windows: documented download link (no curl path required).
- README quick-start documents the one-liner.

## Prereq check

- Phosphor requires `pi` on PATH at runtime (min version pinned in one constant). The installer prints a notice if missing: `npm i -g @earendil-works/pi-coding-agent`. The app itself shows the setup screen ([08-sessions.md](08-sessions.md)) — installer check is advisory only.

## CI (GitHub Actions)

- PR: typecheck, lint, unit tests, renderer build.
- Release (tag push): matrix build all platforms, generate checksums, attach artifacts + install.sh to the GitHub Release, draft release notes.
- e2e smoke (Playwright-Electron) on at least linux + mac runners.

## Versioning

- semver; app "About" shows app version + detected pi version.
