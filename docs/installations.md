# Dependency installation and source closure

The Nx project graph is not one installation domain. npm shares the three
private source libraries, while Desktop, Control and the site keep independent locks.
All targets remain uncached. The Host (`apps/host`, [host.md](host.md)) has no
manifest of its own: it is checked and tested from the root install and imports
only Node builtins and the source libraries. No native Node staging exists.

| Domain                            | Manifest / lock                                                                                             | Ownership                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Root tooling and source libraries | `package.json`, `package-lock.json`; workspaces `libs/shared`, `libs/session-runtime`, `libs/pi-extensions` | JavaScript tools and library dependencies                               |
| Desktop                           | `apps/desktop/package.json`, `apps/desktop/package-lock.json`                                               | Application production dependencies, Electron and Electron-ABI node-pty |
| Control                           | `apps/control/package.json`, `apps/control/package-lock.json`                                               | Hono HTTP server, bundled for plain Node                                |
| Site                              | `apps/site/package.json`, `apps/site/package-lock.json`                                                     | Astro, social-image tools and site checks/browser tests                 |

## Development and CI

Run `npm ci` from the root. Its postinstall runs an independent
`npm ci --prefix apps/desktop && npm ci --prefix apps/control`; failure propagates.
All three installations must be
real local directories, never links to another checkout's mutable installation.
The links npm creates for the three source-library packages point to source in
this checkout, not another installation. Desktop builds use the root's declared
TypeScript, Vite plugins and test tooling plus the app's declared Electron build
and production dependencies. An app-only production install is not a complete
development toolchain.

`npm ci --prefix apps/site` installs only the site and does not invoke the root
or Desktop lifecycle. The site deliberately retains its own TypeScript,
Playwright, Node types and Vite resolutions. Its Docker build context remains
`apps/site`; the build stage runs its own install, check and build. The deployed
nginx stage contains static output, not Node, Electron or workspace links.

Directly imported Playwright tooling is declared at the root, and the Desktop
builder test API is declared in the app. Root tooling must not resolve missing
dependencies from a parent checkout. Existing dependency versions and integrity
identities are retained; adding workspace links is not a toolchain upgrade.

## Scoped source-library production closure

In a **separate staging directory** containing the root manifest/lock, all three
workspace manifests, library sources and TypeScript configuration, the supported
source-dependency install is:

```bash
npm ci --workspace @phosphor/session-runtime --omit=dev --ignore-scripts
```

Do not run this recipe in a development installation: `npm ci` replaces its
node_modules and removes tooling. Both flags are required. npm runs the root
postinstall even for a bare scoped workspace install; without `--ignore-scripts`
that would install/rebuild Desktop. The closure regression uses a sentinel to
prove this distinction. With these flags the runtime scope installs only the
runtime/shared source links, cron-parser and luxon, not root tooling, Electron
or node-pty. No package in this scope needs an install lifecycle.

These private packages export TypeScript source, not runnable or published Host
packages. A compiler supplied by a separate tooling installation must bundle
them with the configured `@shared/*` compatibility mapping. Audit every input's
realpath within the staging root, allow only Node built-ins as runtime externals,
and move compiled output outside the source/install ancestry before plain-Node
execution. Do not use NODE_PATH or compiler-install dependencies to fill holes
in the staged source closure. This recipe proves portable source closure, not a
Host feature or a packaged Node PTY.

## Desktop bundling and native isolation

Desktop bundles shared/session-runtime sources rather than shipping runtime
TypeScript workspace links. Main/preload explicitly exclude these packages from
externalization; renderer/browser resolution deduplicates cron-parser and luxon
onto app-owned copies. `@shared/*` remains a compatibility spelling in configured
builds. Source-package export tests also exercise canonical npm subpath exports.
The pi extensions remain standalone TypeScript resources loaded by pi, not Node
workspace runtime dependencies.

Desktop's Electron bootstrap/rebuild stays app-local. Never rebuild that
node-pty for Node, share its mutable installation, or infer Node ABI compatibility
from an Electron package check. Any future Node native owner requires an explicit
separate install/rebuild domain. See [desktop-build.md](desktop-build.md) for
resource, native and release contracts. Rollback restores manifests and locks
together, then performs fresh domain-local installs, never reuses stale binaries.
