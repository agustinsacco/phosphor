# Nx execution and cache policy

All targets are explicitly **uncached**, including lint, typecheck, unit and
unsigned Desktop compilation. `nx:run-commands` defaults to `cache: false`.
CI never skips a check because of affected projects; it logs a shadow report
beside the full checks. Affected does gate one thing: the Desktop release (see
[Per-app releases and deploys](#per-app-releases-and-deploys)). The original npm
commands and full validator do not depend on Nx.

## Inputs and outputs

Each project reads its own root, its dependencies' roots, and the specific root
files it consumes. That is what makes affected mean something per app:

- `desktop`: libraries, the root install (`rootInstall`), and the repository
  files its release and install use (`release`: `fix-node-pty.mjs`,
  `install.sh`, the release guard scripts, `release-continuous.yml`). E2E adds
  its harness (`e2eHarness`). It does not depend on `tooling`.
- `host`: libraries, plus the root install for `typecheck` and `build` and the
  unit runner for `test`. Its build declares `apps/host/dist`. Only `tooling` depends on it, so a Host-only change selects
  `host` and `tooling` and never the Desktop release.
- `control`: shared contract sources, root install for typecheck/build and the
  unit runner for tests. Its build declares `apps/control/dist`. It explicitly
  depends on `desktop` because `apps/control/src/routes/stack.test.ts` intentionally
  imports Desktop's GoTrue and loopback sign-in flow. This test-only conservative
  edge selects Control for any Desktop change (and changes to Desktop's
  dependencies), not just auth edits; it adds no production cross-app import.
  Only tooling depends on Control. A control-only edit selects control and tooling.
- `site`: `apps/site` only, since its image is built from that directory alone.
  Its build adds `deploy`, which must equal `deploy-site.yml`'s path filter
  (tested). Screenshots are captured by hand from Desktop and committed, so a
  Desktop change does not redeploy the site.
- Libraries: their roots, the root install and `vitest.config.ts`.
- `schema`: `supabase/` and root `package.json`.
- `tooling` runs the whole-workspace checks, so its `workspace` input covers
  every tracked and nonignored untracked file except `.nx`. Nothing depends on
  `tooling`, so docs and CI edits select only it.

Root `package.json`, `package-lock.json` and `nx.json` still select every
project (Nx's own rule for dependency and workspace configuration changes). The
measured per-file matrix lives in `tools/scripts/ci-selection.test.ts`.
Ignored or checkout-external mutable inputs are not a complete cache contract.

Lint and typecheck declare `outputs: []`: ESLint uses no disk cache and
TypeScript uses `--noEmit` without incremental state. Desktop build declares
`apps/desktop/out`; site build declares `apps/site/dist` and
`apps/site/public/og.png`. These declarations describe fresh outputs, not a
cache-restoration guarantee. Deleted-output restoration is inapplicable to
output-free checks and is not promised for uncached builds.

## Why caching stays disabled

The pinned Nx 23.2.1 runtime hasher can hash a runtime-command failure rather
than reject the task. A pre-lookup fingerprint experiment rejected NODE_PATH,
but Nx executed the check successfully and a repeated forbidden invocation
hit that cache entry. Therefore a runtime-input exception is **not** a
fail-closed cache guard. The rejected experiment is not production machinery.

Any future cache proposal must prove a real pre-lookup/read/write boundary,
not a command-time guard or a nonce. NODE_OPTIONS, NODE_PATH and npm shell/node
configuration can reference mutable external code. Hashing only their strings
is insufficient. Supported environment, OS/architecture, Node version/ABI,
Electron/tool versions, own-install origins and consumed untracked or ignored
configuration must be modeled before any target becomes eligible.

Desktop build additionally has three Vite roots, mode/env files and injected
overrides. Site build has font/Sharp/social-image side effects. Unit suites
consume subprocess, git, install and native state. E2E, DB lifecycle, native
rebuild, install, interactive, probe, provider, package, sign, release and deploy
operations are never cache candidates here. No node_modules, credentials,
session/pi/browser homes or DB data are cache outputs.

## Shadow CI selection

The checks job fetches full history and logs actual HEAD, base and OSS Nx projects.
The per-file matrix verifies that Desktop's `account/gotrue.ts` and
`account/loopback.ts` select `control`, `desktop` and `tooling` through the
intentional stack-test edge. The graph stays acyclic and targets stay uncached.
No report controls skipping: the checks, schema and site jobs and every OS
shard remain mandatory behind the single required `CI result` job, and workflow edits select only `tooling`.
So any future skipping must run everything when `tooling` is affected. Equal
base/head is a shadow no-op only.

Same-repository PRs verify main base and PR head ancestry against the checkout.
Main pushes search successful completed CI push/main runs in the same repository,
excluding the current run and requiring an available ancestor commit. Failed main
runs do not advance the baseline. The read-only search checks at most 300 runs
(three pages), with ten-second request timeouts. Exhaustion proves nothing about
older runs.

Forks, merge groups, unsupported events, checkout mismatches, shallow/missing
history and API/Nx/parse failures fall back to all projects. Rollback removes the
shadow step/helper, leaving full uncached checks and release/deployment unchanged.

The full validator always runs an unsigned Desktop build, including with
`SKIP_E2E=1`. Normal E2E retains its own build, deliberately duplicating it rather
than changing the E2E command's freshness guarantee.

## Resource bounds

Nx runs at most three tasks by default. Every Nx unit target bounds Vitest to
two workers, including graph checks. Three simultaneous unit tasks can thus
use six workers; choose a smaller `--parallel` on constrained machines.
`VITEST_MAX_WORKERS=2 npm run validate` bounds the validator's unit workers.
Desktop E2E retains its single Playwright worker.

There is no Cloud, daemon or inference. Explicit `cacheDirectory: .nx/cache`
keeps default state per worktree instead of the pinned Nx version's per-user
shared-cache relocation. Do not override it to share writable state.

Regression checks enforce the uncached policy, declared outputs and worker
bounds without depending on Nx preserving its runtime-error behavior. Acceptance
requires repeated protected tasks to execute fresh and original uncached
validation. To roll back scheduling only, restore `parallel: 1` and remove unit
env overrides; cache remains disabled and graph/install boundaries stay intact.

## Per-app releases and deploys

- **Desktop** (`release-continuous.yml`): after CI passes on a `main` push, the
  guard publishes only if Nx `desktop` is affected between the last published
  release tag and the validated commit (`tools/scripts/release-scope.mjs`). It
  compares against the last release, not the previous commit, so a Desktop
  change still ships when a newer push cancels its release run. A missing
  release, a tag off this history, or any git/Nx/install failure releases.
  Manual `workflow_dispatch` is main-only and verifies successful push CI for
  the exact SHA (the newest attempt wins); it bypasses only affected selection,
  never CI or `Skip-Release: true`. Every checkout is pinned to that SHA.
  This is the only release workflow; tag pushes do not build another release.
  One release builds macOS and Linux into a draft (Windows is paused; see
  [future-features.md](future-features.md#windows-builds)). All platform jobs,
  binary/manifest presence checks and checksum generation must pass before it
  becomes latest. A failed or cancelled build leaves the previous release live;
  rerun the workflow to resume the same SHA's draft. Existing published tags
  remain no-ops. Release cadence, versioning, asset names and update URLs are unchanged.
- **Site** (`deploy-site.yml`): a `main` push touching its path filter (equal to
  the `site` project's root plus `deploy` input) deploys after exact-SHA CI,
  unless the hold variable or a `Skip-Release: true` trailer stops it.

Schema, docs and CI-only merges ship nothing.

## GitHub retention

Full CI still runs on every PR update and main push. `Continuous Release`
listens only to main CI completions and retains its push/success/repository
checks. These policies do not introduce affected-only checks or build caching.

- Site browser evidence uploads only on job failure or when the PR event carries
  the `keep-ci-artifacts` label. Add the label **before the next push**; rerunning
  an older event does not refresh its labels. These artifacts expire after
  three days. Desktop E2E failure reports retain seven days.
- `cleanup-pr-caches.yml` removes only `refs/pull/<number>/merge` and `/head`
  caches when that PR closes, including forks. The privileged close hook uses
  trusted default-branch inline code, never checks out the PR and never executes
  its contents. Named-branch caches are untouched. Late cache uploads still
  expire through GitHub's seven-day eviction policy.
- Docker build records use three-day retention. Published releases and tags
  are not automatically pruned: they are installation and rollback URLs, not
  Actions artifacts. Failed drafts are retained for retries; delete an obsolete
  draft only after confirming no release run still owns it.

The repository keeps the 10 GiB Actions cache cap. Main requires a PR and the
existing eight CI checks, with no mandatory approval count; force-push and
branch deletion are blocked. These protections and dependency alerts are
GitHub repository settings, not configured by a workflow.
