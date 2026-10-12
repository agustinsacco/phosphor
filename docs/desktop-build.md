# Desktop build and native packaging

Desktop lives at `apps/desktop`: Electron main/preload, renderer, E2E,
platform assets, TypeScript/Vite/Playwright configuration, builder configuration
and the application manifest. Root npm commands remain the tooling facade.
`npm run build` delegates to the app, producing `apps/desktop/out/main/main.js`,
`out/preload/preload.cjs` and `out/renderer` relative to that application.
Sandboxed preload remains CommonJS. Development `app.getAppPath()` is the
Desktop directory; packaged `app.getAppPath()` is the application asar.

## Installation domains

`npm ci` at the root installs shared tooling, then its postinstall invokes
`npm ci --prefix apps/desktop`. Desktop has its own manifest, lockfile and real
`node_modules` directory. Its postinstall bootstraps Electron serially with the local `install-electron`
command, then runs `electron-builder install-app-deps`
and the app-anchored spawn-helper repair. `npm run rebuild --prefix apps/desktop`
explicitly rebuilds node-pty for Electron and repeats that repair.
Root has no node-pty, Electron or Electron rebuild lifecycle of its own.
Failures in the nested app install propagate to the root install.

The root lock includes only the three private source-library workspaces.
Nonnative JavaScript dependencies remain in the root installation for portable
library tests as well as in Desktop. Desktop and the site keep independent
installations and lockfiles; this is bounded library consolidation, not one
application install domain. The supported scoped source-production recipe must
suppress root install scripts, as specified in [installations.md](installations.md).
Renderer
and browser builds deduplicate the source libraries' luxon/cron-parser imports
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

## Resources and release

App-relative `build/` supplies platform icons, entitlements and the development
tray. Builder copies the tray to `resources/routine-tray.png`, and the eight
production TypeScript extension files to `resources/pi-ext` with six entrypoints.
Tests are excluded; extensions remain readable outside the asar by pi.
Development sessions resolve extensions from `../../libs/pi-extensions` relative
to the app. Packaged sessions still use `process.resourcesPath`.

Builder packages only `out/`, the application manifest and production dependency
closure. node-pty is unpacked from the asar, with its spawn-helper executable.
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
