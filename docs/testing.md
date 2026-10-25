# Testing

This is the living contract for test layout, frozen interfaces and local/CI
guardrails. Tests provide evidence of behaviour; coverage and size reports do not
replace assertions or independent review.

## Install and run

Use Node 22.19+ and local dependency installations in this checkout:

```bash
npm ci
npm ci --prefix apps/site
npm run typecheck
npm run lint
npx prettier --check .
npm test -- --maxWorkers=2
node tools/scripts/size-budget.mjs check
```

Root `npm ci` also installs Desktop, Control and Web through postinstall. The site is
an independent dependency domain, not a root workspace. Both the comprehensive
typecheck and the whole-repository typecheck-coverage unit test require its local
TypeScript and Astro tools. A missing install fails, rather than falling back to
an ancestor's tools or skipping a domain.

`npm run typecheck` runs the all-file coverage audit, then Desktop main/preload,
renderer, shared client-ui, browser-safe host-client and its Node test project,
Web source, worker, unit tests and browser e2e types, shared, session-runtime, pi-extensions, Host,
Control, tooling and the site's Astro check. The project list lives in
`tools/scripts/typecheck-coverage.mjs`. The standalone audit is useful when
checking membership without compiling:

```bash
node tools/scripts/typecheck-coverage.mjs
```

The audit includes tracked and untracked candidate `.ts`, `.tsx`, `.mts`, `.cts`
and declaration files. Gitignored generated outputs are not candidates; tracked
declarations have no blanket exemption. Standalone `typecheck:host` and
`typecheck:control` aliases remain available, but CI does not rerun them after the
comprehensive command.

For focused and end-to-end checks:

```bash
npx vitest run tools/scripts/test/foundation-wiring.test.ts
npx vitest run tools/scripts/validate.test.ts
npm run test:e2e
SKIP_E2E=1 npm run validate
```

Use `--maxWorkers=2` for broad Vitest runs. Re-run a timeout alone before calling
it a regression. `npm run validate` runs typecheck, lint, formatting, unit tests,
Desktop/Host/Control/Web builds and Desktop/browser e2e, with a PASS/FAIL summary and log file.
`SKIP_E2E=1` skips only e2e, never builds. E2E exercises the Electron app against
the pi stub; packaging builds are not part of unit validation.

E2E windows never appear on your screen, so a background agent running the
suite cannot steal focus. `tools/scripts/e2e.sh` prefers `xvfb-run` (real
windows on a virtual display, full speed) and otherwise leaves windows unmapped
(`hideWindowsForE2E` in `apps/desktop/electron/window-chrome.ts`), about 2-3x
slower because Chromium deprioritizes a window that was never shown.
`PHOSPHOR_E2E_SHOW=1 npm run test:e2e` shows them on your display.

Hidden windows still share your system clipboard. Desktop tests tagged
`@system-clipboard` are excluded locally, including when selected with `-g`:
otherwise a background run can replace a copied screenshot with a test image or
text such as `phosphor_menu_paste_9d3c`. CI runs these cases. To run them locally,
explicitly opt in with `PHOSPHOR_E2E_CLIPBOARD=1 npm run test:e2e`; do not use the
clipboard during that run. Synthetic paste/drop tests need no opt-in and never
write to the system clipboard. We do not save and restore the clipboard: restoring
an old snapshot could overwrite something you copied while the suite was running.

## Layout and helpers

Tests currently live beside their subjects as `*.test.ts` or `*.test.tsx` across
Desktop, Host, Web and libraries (including the extracted UI in `libs/client-ui/src`). This is temporary until RL-03 moves them to `test/`
folders. Foundation tools and freeze suites already use `tools/scripts/test/`,
`apps/desktop/test/` and `libs/shared/test/`; the legacy
`tools/scripts/__tests__/` directory also remains. Do not mechanically relocate
tests as part of a behaviour change. Fixtures use sibling `__fixtures__/`
folders. DOM suites opt in with `// @vitest-environment jsdom`; prefer pure logic
and source-named tests over component tests when possible.

Renderer tests use the typed helper
`apps/desktop/test/renderer/helpers/fakePhosphor.ts`, not partial objects cast to
`PhosphorApi`. `createFakePhosphor(handlers, options)` returns `api`, typed
`events` and `dispose()`. Handlers are channel-specific and unconfigured invokes
reject. `installFakePhosphor(fake)` returns a restore function; restore and
`dispose()` in `afterEach`, restoring nested installations in reverse order.
The helper stays test-only outside the shipping browser graph and changes no globals until explicitly installed. Event emitters model
keyed subscriptions and unsubscribe behaviour without Electron.

## Characterization and freeze rules

A unit that specifies characterization starts with a test-only
`test(<ID>): characterize <behaviour>` commit. Run it through the original public
entry on unchanged source and pin observable results, errors, ordering and
timing where relevant. Once committed, its added lines are frozen: do not edit
or delete them; append new cases instead. Fix, security and performance units
then add a test-only `test(<ID>): regression <defect>` commit that fails by
assertion on the current source, before implementation. Tooling and docs units
do not invent characterization when none is specified. Implementation commits
use `<type>(<ID>): <imperative summary>`; do not squash away evidence before the
unit gate runs.

The interface freeze suites have literal reviewed baselines, not auto-updated
snapshots:

- FD-09: `libs/shared/test/ipc.freeze.test.ts` pins IPC channels and scopes;
  `apps/desktop/test/main/preload.freeze.test.ts` exercises the original preload
  exposure, forwarding and subscription cleanup.
- FD-10: `libs/shared/test/host-protocol.freeze.test.ts` and
  `libs/shared/test/control-api.freeze.test.ts` pin protocol shapes,
  discriminants, routes and parser acceptance/rejection. These are shape
  evidence, not substitutes for authorization conformance tests.
- FD-11: `tools/scripts/test/status-wire.freeze.test.ts` pins lowercase status
  keys, structured widgets and the async payload prefix across producers and
  consumers, including external Claude compatibility.

A wire change needs explicit review of the contract and its baseline, not a
snapshot update flag. Frozen characterization remains unchanged during its unit.

## Inventory, coverage and unit acceptance

These tools run in a trusted per-unit pipeline with owner-supplied inputs, not
from arbitrary PR manifests in GitHub CI. Keep evidence outside the checkout and
retain immutable pre-squash refs. The paths below are example evidence inputs;
provide the real owner-approved unit, move map and gate JSON before invoking.

```bash
node tools/scripts/test-inventory.mjs collect --out /tmp/inventory-before.json
node tools/scripts/test-inventory.mjs run --out /tmp/execution.json tools/scripts/validate.test.ts
node tools/scripts/test-inventory.mjs compare --before /tmp/inventory-before.json --after /tmp/inventory-after.json --map /tmp/moves.json
node tools/scripts/unit-coverage.mjs --unit /tmp/unit.json --before "$BEFORE_SHA" --after "$FINAL_SHA" tools/scripts/validate.test.ts
node tools/scripts/unit-gate.mjs --input /tmp/gate.json
```

`test-inventory` accepts optional explicit test files for `collect` and `run`,
plus `--map moves.json`. Compare like kinds: collection counts are not execution
counts. Identities use owning project, canonical old path, full name and occurrence
ordinal, not Vitest task IDs. Execution retains skipped and todo cases;
collection does not include all of them. Comparison requires matching OS and
Node major unless `--allow-platform-mismatch` is explicitly approved. A
relocation map is `{ "version": 1, "moves": [{ "from": "old/path.test.ts", "to": "new/path.test.ts" }] }`.

`unit-coverage` accepts optional `--map moves.json` and requires the same explicit
passing tests at both refs. Use characterization as the before ref, otherwise
the last regression commit with red tests omitted, otherwise the unit base.
It measures aggregate statements across all tracked owned JS/TS sources,
including unimported helpers; tests and declarations are excluded. It reports
covered/total and denominator change and refuses coverage decreases, lost scope,
failed tests and missing reports. There is no global percentage target.

`unit-gate --input` takes the `GateOptions` JSON documented in
`tools/scripts/unit-gate.mjs`: `root`, immutable `baseSha`/`finalSha`, optional
`characterizationSha`, `unit`, an owner-expanded exact multi-unit `manifest`,
an unused `evidencePath`, and coverage with its before/after refs when owned
executable source exists on both sides. Dependency acceptance is owner-supplied,
not self-approval. Explicit owner approval, a map and one exact-content move
commit are required for relocation. The gate verifies ownership, commit order,
frozen characterization, assertion-red regressions, test execution and coverage,
then exclusively creates JSON evidence. Retain it before squashing; inventory
comparison is separate evidence in the per-unit pipeline.
Do not run this tool against untrusted PR data in CI.

## Dry-run relocation planner

`node tools/scripts/relocate-tests.mjs --plan` only emits a hashed JSON plan;
`--apply` and `--verify` are refused. Existing colocated tests are not moved.
The mapping table in `tools/scripts/relocation/map.mjs` covers Desktop, Host,
Control, Web, shared UI, host-client and the other libraries. `@/` resolves to
`libs/client-ui/src`, not Desktop's native bootstrap. The shipping replay fixture
is planned for `libs/client-ui/src/dev/fixtures`, with its shipping consumer
reported for review rather than silently rewritten. Existing `test/` trees,
e2e, site and Supabase paths retain their boundaries. Run inventory and inspect
collisions, importer edits, budget renames and report-only paths before any
separately approved relocation.

## Size budgets and lint ratchets

```bash
node tools/scripts/size-budget.mjs check
node tools/scripts/size-budget.mjs check --strict
```

`tools/budgets/*.json` covers eleven packages. Production files have a 400-line
budget, functions 80 lines, test files 800 lines. Suite registration callbacks
are not ordinary functions. Exemptions are limited to declaration and
generated-file entries with an exact file/rule, rationale and owner; long e2e
callbacks are baselined offenders, not exemptions. Existing offenders are one-way ceilings: new or grown
spans fail, shrinking/removal is allowed, and checks never rewrite baselines.
Renames need explicit mappings. The UI extraction transfers Desktop renderer
ceilings and its icon-declaration exemption to `client-ui`; `web` and
`host-client` have separate budgets. Integration allowances for existing PWA
debt are measured from commit `9dfff24b`, never from new integration code. `--strict` also fails remaining baseline debt;
it is not CI's default while that debt exists.

`npm run lint` runs ESLint, then oxlint's type-aware pass (`.oxlintrc.json`,
backed by tsgolint, the TypeScript 7 checker), then the dead-mock check. ESLint
is syntax-only: it never builds a TypeScript program.

`no-floating-promises` and `no-misused-promises` are oxlint errors in every
file a TS project owns: Desktop main/preload, every library, Host, Control and
the Web app. Each file is typed by its own nearest tsconfig, so a file outside a
project reports a tsconfig error rather than passing. Desktop renderer, e2e and
tooling stay outside that pass. `tools/scripts/test/lint-policy.test.ts` pins both
lists against the real config. Renderer raw-`piCommand`, `rules-of-hooks`,
native-confirm, prompt and Host boundary rules are ESLint errors. The RPC wrapper
and test doubles have narrow exemptions.

Violations that predate a rule are recorded in `eslint-suppressions.json` and,
for the promise rules, `oxlint-suppressions.json`. Both linters fail on a new
violation and also on a recorded one that no longer occurs, so the records only
shrink: after fixing one, run `npx eslint . --prune-suppressions` or
`npx oxlint --type-aware --prune-suppressions .` and commit the smaller file.
Never add to either with `--suppress-rule`/`--suppress-all` to land a change.
Only `exhaustive-deps` stays a warning: an inventory for owners, not a
zero-warning CI budget. Do not disable rules or weaken types to pass a unit.

`npm run lint` also runs `tools/scripts/dead-mocks.mjs`. It fails when a test
`vi.mock`s a workspace module that nothing the test loads imports: such a mock
passes silently while the code under test uses the real module. Mock the module
the code imports now, or delete the mock.

## CI boundary

CI runs on the project's own runners, two Linux (x64) and one macOS (ARM64),
selected by their `[self-hosted, Linux, X64]` and `[self-hosted, macOS, ARM64]`
labels. Each runner takes one job
at a time, so jobs on the same OS queue and a split pays only when there is a
runner instance to take it. Each job installs what it needs and runs each
mandatory command exactly once:

- `checks`: root and site installs, comprehensive typecheck (including the
  all-file audit), then the size ratchet.
- `lint`: `npm run lint` (ESLint, typed oxlint, dead mocks) and
  `npx prettier --check .`.
- `build`: the Desktop, Web, Host and Control builds.
- `unit`: `npm test`, with the site installed too for the coverage audit's own
  test.
- `web-e2e`: the browser acceptance suite, one leg per engine (Chromium,
  WebKit), each installing only its own browser. Like Desktop it retries a
  failed test once on CI and reports it as flaky.
- `e2e`: the Desktop suite, one Linux leg under xvfb. macOS runs the whole suite
  on main, which gates every release, and on a PR only the tests tagged
  `@macos` (native quit, undo, context menus, Meta shortcuts, the system
  clipboard and the login shell). A test whose macOS behaviour differs from
  Linux beyond the modifier key carries the tag. Linux sets `PHOSPHOR_E2E_SHOW=1`:
  windows that are never mapped barely render there, which made the suite several
  times slower. macOS keeps the windows hidden, as local runs do, so nothing
  appears on the Mac runner's screen. On Linux the suite's global setup (`apps/desktop/e2e/warm-up.ts`)
  first launches Electron until one launch paints a frame: on a fresh runner the
  first launch never does, so the first test of every run used to time out a
  click and pass on retry. The macOS runner must run inside a logged-in user
  session, and its `@system-clipboard` tests overwrite that user's clipboard.
- `control-schema` and `site`: the local Supabase stack and the site image.

A Linux runner needs `xvfb`, Docker (with the runner user in the `docker`
group) and the browsers' system libraries, installed once with
`sudo npx playwright install-deps chromium webkit`. Jobs install only the
browsers themselves, without sudo.

The repository is public, so a fork's pull request runs on these machines once
a maintainer approves it. Approve outside contributors' runs only after reading
the diff.

The audit's own tests also run in `npm test`; there is no redundant standalone
audit step. No job is skipped by affected projects. Inventory artifacts,
coverage comparisons and unit-gate evidence belong to the trusted per-unit
pipeline, not CI's untrusted PR input.

The final `CI result` job always aggregates every required job: `checks`,
`lint`, `build`, `unit`, `control-schema`, `site`, `e2e` and `web-e2e`. Every
result must be `success`, including all matrix legs.
`tools/scripts/test/foundation-wiring.test.ts` guards these steps and the
documented commands against accidental removal.
