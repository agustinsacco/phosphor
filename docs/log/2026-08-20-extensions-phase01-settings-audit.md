# 2026-08-20 — Extensions management + first-run onboarding (Phase 0+1 of EXTENSIONS_PLAN)

Phosphor now manages pi packages and can bootstrap a machine that has no pi at
all. Full plan and architecture: `specs/archive/EXTENSIONS_PLAN.md`, deleted
2026-08-27 (`git show 737f18e:specs/archive/EXTENSIONS_PLAN.md`) — its durable
half is [reference/extensions.md](../extensions.md). (This entry is
its Phase 0+1 landing).

**Settings → Extensions tab.** Lists every entry of both scopes' `packages`
arrays (global `~/.pi/agent/settings.json`, project `.pi/settings.json`),
resolved against the install dirs pi actually uses (verified against pi
0.84.2: npm under `<base>/npm/node_modules/<name>`, git under
`<base>/git/<host>/<path>`, relative paths against the settings file's dir)
and enriched from each package's `package.json` + `pi` manifest or
convention directories. Mutations never re-implement install semantics:
`packages:run` shells out to pi's own package manager (`pi install`,
`pi remove`, `pi update --extensions`, `-l` + cwd for project scope) with
output streamed to the UI over `packages:output:<jobId>` /
`packages:exit:<jobId>` (pty-style channels). A curated catalogue
(`src/features/settings/catalogue.ts`) fronts pi.dev/packages:
`@saccolabs/pi-claude-cli` (Claude Pro/Max provider, gated on `claude`
binary detection via `packages:detect`), `pi-mcp-adapter`, `pi-web-access`,
`pi-subagents`.

**First-run onboarding.** `PiMissingScreen` gained one-click
"Install pi" / "Update pi" (`packages:installPi` →
`npm install -g @earendil-works/pi-coding-agent` through the login-shell
env, so fnm/nvm users work from a GUI launch), with streamed output and
auto re-check. A successful install lands on `GettingStartedScreen`:
provider guidance (subscription `/login`s, API keys → Agent tab) plus the
same catalogue cards, then Continue into the app.

New surface: `electron/pi/packages.ts` (+ job runner),
`electron/ipc/packages-handlers.ts` (`packages:` prefix),
`packages:list/run/installPi/detect` in `shared/ipc.ts`,
`onPackagesJobOutput`/`onPackagesJobExit` in the preload, mock cases for
all of it. Coverage: 10 unit tests for spec classification, npm/git/path
install-dir resolution, both-scope listing with manifest and
convention-dir discovery, malformed-settings tolerance (fixture dirs via
`PI_CODING_AGENT_DIR`).

**Settings audit vs pi 0.84.2 (same day).** Function-by-function pass over
the whole settings surface against pi's `docs/settings.md`. Fixed: AgentTab
offered thinking levels only up to `xhigh` (0.84 supports `max`); AgentTab
edited the _merged_ global+project view, so a project override silently
displayed inherited global values and absorbed them on the next edit — it
now reads per-scope files via new `pi:agentSettingsScoped` and shows
inherited values as placeholders ("inherits \"anthropic\""); nested patches
send only the changed key (`{compaction: {enabled}}`), relying on the
existing one-level server-side merge, so overrides stay minimal.
`readAgentSettings` merged scopes shallowly while pi merges nested objects
one level deep — a project `{compaction:{reserveTokens}}` wrongly hid the
global `compaction.enabled` from the effective view (store + home picker);
now mirrors pi's documented semantics. McpTab migrated off the
settings-edit install onto `packages:run` (streamed `pi install`) and reads
adapter presence from per-scope `packages:list` — the merged view would
misreport when a project declares its own packages array. Advanced's
resource viewer gained the missing `themes` kind and is relabeled as local
loose files (packages live in the Extensions tab). Coverage: +4 unit tests
(deep-merge example straight from pi's docs, scoped reads, packages tests
already in place); full validate green.
