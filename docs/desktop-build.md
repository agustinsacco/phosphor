# Desktop build and native packaging

Desktop lives at `apps/desktop`: Electron main/preload, renderer, E2E,
platform assets, TypeScript/Vite/Playwright configuration, builder configuration
and the application manifest. Root npm commands remain the tooling facade.
`npm run build` delegates to the app, producing `apps/desktop/out/main/main.js`,
`out/preload/preload.cjs` and `out/renderer` relative to that application.
Sandboxed preload remains CommonJS. Development `app.getAppPath()` is the
Desktop directory; packaged `app.getAppPath()` is the application asar.
The renderer build needs more than Node's default 2 GB heap on machines with
less than 16 GB of memory, so the release build sets
`NODE_OPTIONS=--max-old-space-size=4096`; do the same locally if it runs out.

## Installation domains

`npm ci` at the root installs shared tooling, then its postinstall invokes
`npm ci --prefix apps/desktop`, then the independently locked Control and Web installs. Desktop has its own manifest, lockfile and real
`node_modules` directory. Its postinstall bootstraps Electron serially with the local `install-electron`
command, then runs `electron-builder install-app-deps`
and the app-anchored spawn-helper repair. `npm run rebuild --prefix apps/desktop`
explicitly rebuilds node-pty for Electron and repeats that repair.
Root has no node-pty, Electron or Electron rebuild lifecycle of its own.
Failures in the nested app install propagate to the root install.

The root lock includes the eight private source-library workspaces.
Nonnative JavaScript dependencies remain in the root installation for portable
library tests as well as in Desktop. Desktop, Control, Web and the site keep independent
installations and lockfiles; this is bounded library consolidation, not one
application install domain. The supported scoped source-production recipe must
suppress root install scripts, as specified in [installations.md](installations.md).
Renderer
and browser builds deduplicate React/React DOM/zustand and the source libraries' luxon/cron-parser imports
onto the application's copies. Private source libraries are bundled, not
runtime workspace links.

Never symlink or share a mutable `node_modules` or native rebuild directory
between worktrees or runtimes. Desktop's node-pty belongs to Electron's ABI.
A future plain-Node terminal owner needs a different install/rebuild domain;
plain-Node session-runtime tests do not load Desktop's native module.
Playwright tests and screenshot scripts explicitly select the app-owned
Electron executable, even when Playwright itself is installed at the root.
The shared test/capture launcher also preloads the installed Playwright Electron
loader, preserving its screenshot switches and readiness handshake. A test-only
preload removes its own exact require-argument pair before invoking that loader,
so explicit-executable launches retain the default app argv too. Playwright
does not add that loader automatically when an explicit executable is supplied.
CI failure artifacts are collected from `apps/desktop/playwright-report` and
`apps/desktop/test-results`, matching the app-owned Playwright configuration.

Root tooling declares esbuild explicitly for portable package/boundary tests.
These imports must resolve inside the root installation, not from an ancestor
checkout; Vite retains its separate nested esbuild version.

## Never package in the main checkout

A packaging build (`electron-builder`, or anything that writes `release/`) in
the main checkout drops a complete `Phosphor.app` under `release/`. Spotlight
indexes it exactly like the real install in `/Applications`: same name, no
version in search. Launching the stale one looks like a broken updater ("Update
available" never clears). On 2026-08-27 a stray build five versions behind was
launched this way. Install from the DMG on GitHub Releases and let it update
itself. If a local package is ever needed, point the output outside the repo.

## Resources and release

App-relative `build/` supplies platform icons, entitlements and the development
tray. Builder copies the tray to `resources/routine-tray.png`, and the eight
production TypeScript extension files to `resources/pi-ext` with six entrypoints.
Tests are excluded; extensions remain readable outside the asar by pi.
The two Brain entrypoints are excluded from this raw TypeScript copy:
`tools/scripts/build-brain-extensions.mjs` stages standalone `brain-ext/brain.mjs`
(recall) and `brain-fork-guard.mjs` (the knowledge fork's tool guard) for Desktop
and Host resources. Staging does not enable them, and Hosts do not activate Brain.
The `brain` skill ships with the other skills under `resources/skills`.
Development sessions resolve extensions from `../../libs/pi-extensions` relative
to the app. Packaged sessions still use `process.resourcesPath`.

Builder packages only `out/`, the application manifest and production dependency
closure. node-pty is unpacked from the asar, with its spawn-helper executable.
The main bundle has four entries: `out/main/main.js`, `out/main/voice-worker.js`,
`out/main/brain-embedding-worker.js` and `out/main/brain-search-worker.js`.
Brain bundles its private source libraries but externalizes Transformers.js.
ONNX Runtime and `@img` native packages unpack together; target-foreign binaries
and the unused web/WASM runtime packages are excluded. `.npmrc` suppresses ORT's
optional install download. Model files are never packaged or fetched at build
or startup. The native Brain runtime is enabled only on darwin-arm64.

Offline development and packaged-asar-layout embedding probes have passed on an
Apple M4 Pro using Electron 43.8.3. The packaged-layout probe used stock Electron,
not the signed/notarized application executable. Signing/notarization and complete
ORT/libvips redistribution license text remain release gates; see the bundled
[notice inventory](../apps/desktop/build/brain-third-party-notices.md). These probes
do not establish public-release readiness.

The voice utility process is unchanged. Its speech runtime, `sherpa-onnx`, is the
WebAssembly build: plain JavaScript and a `.wasm` file that load from inside the
asar, with nothing to rebuild per architecture. The macOS `Info.plist` carries
`NSMicrophoneUsageDescription` and the entitlements include audio input
([voice.md](voice.md#privacy-and-permissions)).
App ID, updater metadata, installer names, retained Windows app data and macOS
signing policy are unchanged. Both macOS architectures remain in one builder
invocation so `latest-mac.yml` cannot be overwritten by separate jobs.
Release versions still use the validated history's commit count, injected into
the app manifest by builder. Only commits that change Nx `desktop` since the last
published release publish one ([nx-cache.md](nx-cache.md#per-app-releases-and-deploys)).
`Skip-Release: true` keeps structural commits from publishing; the deployment
hold and exact-SHA CI guard remain in force. A confirmed manual run of the site
deploy with `ignore_skip_release` deploys past the trailer, never past the hold.

Generic maintainer scripts live at `tools/scripts`; the signing hook and its
fixtures live inside `apps/desktop/scripts`, as required by builder's hook-module
workspace guard. Workflow commands use the app
package command, and package artifacts live at `apps/desktop/release` on hosted
runners. Local packaging must override `directories.output` to an absolute
managed scratch path, never a checkout `release/` directory. Do not install or
launch that scratch bundle against real user data. Signing/update behavior is
owned by [updates.md](updates.md).

## Native modules and the glibc floor

Native modules (node-pty above all) are compiled on the build machine by
`npmRebuild` and `electron-builder install-app-deps`, so they link against
that machine's system libraries. node-pty ships no Linux prebuild, so the
compiled `build/Release/pty.node` is the only one a Linux user gets.
glibc is backward- but not forward-compatible: a binary built on a newer
glibc does not load on an older one. The runner image therefore sets the
oldest OS a release runs on.

- Release build jobs use pinned runner images, never `*-latest`
  (`tools/scripts/release-workflow.test.ts` enforces it). Linux builds on
  `ubuntu-22.04`, which makes the floor **glibc 2.35** (Ubuntu 22.04,
  Debian 12). Moving the runner moves the floor; change both together.
- After packaging, `tools/scripts/check-glibc-floor.mjs` fails the release
  if any ELF `.node`/`.so` needs a newer `GLIBC_x.y` than `GLIBC_FLOOR`, and
  the job loads node-pty inside the packaged Electron.
- `apps/desktop/electron/pty/pty-manager.ts` loads node-pty on first use, so a
  module that cannot load disables terminals with its real error instead of
  killing the app before its first window. v0.1.608 did exactly that: its
  `pty.node` needed GLIBC_2.42 after `ubuntu-latest` moved.
