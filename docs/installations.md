# Dependency installation and source closure

The Nx project graph is not one installation domain. npm shares five private source libraries, while Desktop, Control, Web and the site keep independent locks.
All targets remain uncached. The Host (`apps/host`, [host.md](host.md)) has no
manifest of its own: it is checked and tested from the root install and imports
Node builtins, `ws` and the source libraries. Signed Host releases stage their
own pinned Node runtime and target-specific node-pty resources, separate from
Desktop's Electron ABI ([Host releases](host.md#build)).

| Domain                            | Manifest / lock                                                                                                                                   | Ownership                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Root tooling and source libraries | `package.json`, `package-lock.json`; workspaces `libs/shared`, `libs/session-runtime`, `libs/host-client`, `libs/pi-extensions`, `libs/client-ui` | JavaScript tools and library dependencies                               |
| Desktop                           | `apps/desktop/package.json`, `apps/desktop/package-lock.json`                                                                                     | Application production dependencies, Electron and Electron-ABI node-pty |
| Control                           | `apps/control/package.json`, `apps/control/package-lock.json`                                                                                     | Hono HTTP server, bundled for plain Node                                |
| Site                              | `apps/site/package.json`, `apps/site/package-lock.json`                                                                                           | Astro, social-image tools and site checks/browser tests                 |

The Web domain uses `apps/web/package.json` and its own lock for Vite/React. It builds the compact shell from `libs/client-ui`; Desktop imports that library's expanded entry. The UI also consumes the self-contained `lane-reload`, `swarm` and `subagent-snapshot` wire helpers from `libs/pi-extensions`. The Web image builder copies only those three helper sources, not the extension runtime.

## Development and CI

Run `npm ci` from the root. Its postinstall runs an independent
`npm ci --prefix apps/desktop && npm ci --prefix apps/control && npm ci --prefix apps/web`; failure propagates.
All four installations must be
real local directories, never links to another checkout's mutable installation.
The links npm creates for the five source-library packages point to source in
this checkout, not another installation. Desktop builds use the root's declared
TypeScript, Vite plugins and test tooling plus the app's declared Electron build
and production dependencies. An app-only production install is not a complete
development toolchain.

`npm ci --prefix apps/site` installs only the site and does not invoke the root
or Desktop lifecycle. The site deliberately retains its own TypeScript,
Playwright, Node types and Vite resolutions. The combined image
uses the repository root as its context, with `apps/control/Dockerfile.dockerignore`
limiting inputs. Separate site, Control and Web build stages use isolated installs. Web additionally installs root source-library tooling with `--ignore-scripts`, never Desktop's native lifecycle.
The site stage checks and builds Astro. The Control stage bundles with its pinned
esbuild. The Node 22 runtime contains only static output and `server.mjs`, not
Electron, node_modules or workspace links.

Directly imported Playwright tooling is declared at the root, and the Desktop
builder test API is declared in the app. Root tooling must not resolve missing
dependencies from a parent checkout. Existing dependency versions and integrity
identities are retained; adding workspace links is not a toolchain upgrade.

## Scoped source-library production closure

In a **separate staging directory** containing the root manifest/lock, all five
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
runtime/shared/host-client source links, cron-parser and luxon, not root tooling, Electron
or node-pty. No package in this scope needs an install lifecycle.

These private packages export TypeScript source, not runnable or published Host
packages. A compiler supplied by a separate tooling installation must bundle
them with the configured `@shared/*` compatibility mapping. Audit every input's
realpath within the staging root, allow only Node built-ins as runtime externals,
and move compiled output outside the source/install ancestry before plain-Node
execution. Do not use NODE_PATH or compiler-install dependencies to fill holes
in the staged source closure. This recipe proves portable source closure, not a
Host feature or a packaged Node PTY.

## Browser-safe Host client

`libs/host-client` imports only shared browser-safe contracts. Session-runtime
re-exports its projection; the client never imports session-runtime or Desktop.
Desktop supplies Node identity crypto and retains its test-only endpoint adapter.
The portable default uses WebCrypto and requires an enrolled HTTPS Tailscale endpoint.

`npm run typecheck:client` checks the DOM-only source environment. Root unit
selection includes the client suites. The Chromium and WebKit crypto checks run in
the web e2e suite (`apps/web/e2e/host-client-crypto.spec.ts`), which installs its
own engine. CI and `npm run validate` require the client typecheck;
the library's Nx test target and whole-workspace unit target discover its tests.

## Shared UI and Web builds

`libs/client-ui` exports Desktop and compact entries, typed navigation, platform capabilities and shared CSS. Colocated tests/assets move with it; `@/` resolves to this library. `apps/desktop/src` retains native bootstrap and HTML only. Root checks include UI/Web types and tests; `npm run web:build` produces `apps/web/dist`. The browser build rejects Node/Electron/runtime/test modules. Its cron-parser alias selects the identical expression parser class without the package barrel's Node-only file reader. Browser assets/workers require Vite, so the Node source-closure bundler deliberately does not treat UI exports as Node entrypoints.

## Desktop bundling and native isolation

Desktop bundles shared/session-runtime/host-client sources rather than shipping runtime
TypeScript workspace links. Main/preload explicitly exclude these packages from
externalization; renderer/browser resolution deduplicates React, React DOM, zustand, cron-parser and luxon
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
