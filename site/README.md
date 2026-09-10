# phosphor.saccolabs.com

The production landing page in `site/`: Astro 7, Tailwind 4, static HTML, no
client framework and **no shipped JavaScript**. The approved surface study now
replaces the previous page at the canonical deployment path; there is no second
site directory or deployment.

## Run and check

```bash
npm ci --prefix site
npm run dev --prefix site
npm run check --prefix site
npm run build --prefix site
(cd site && npx playwright install chromium)
npm test --prefix site
```

Playwright serves the production build on `127.0.0.1:4322`. It checks desktop,
mobile, JavaScript-disabled desktop/mobile and reduced motion; keyboard radio
navigation, native disclosures, image/asset responses, console and page errors,
internal anchors, 320–1920px overflow, enlarged layout, and zero client scripts.
Screenshots and failure traces go to the ignored `test-results/` directory. CI
runs this suite against the production Docker image and uploads its evidence.
Set `SITE_TEST_URL=http://127.0.0.1:<port>` to test an already-running container
locally instead of starting Astro preview. Electron e2e is not the website's test
harness; no app, IPC or session behavior changes here.

Formatting Astro files explicitly loads the plugin:

```bash
npm run format --prefix site
```

## The exact IDE capture

`site/src/assets/shots/ide-flex.png` is the original **6012 × 3322** full-window
capture supplied by the user during review, preserved unchanged in this
site's self-contained asset directory. It shows the Headroom Optimization
session: explorer and Monaco (`TopBar.tsx`) left, Claude Opus 5 transcript and
results table right, Max thinking and a 35% context meter in the composer.
The figures are historical session output, not a product benchmark.

The original input checkout lacked this file. The supplied attachment resolved
that dependency; the temporary GPT-5.5 fallback and its warning have been removed.
Build and deployment require the real capture.

Run `npm run shots --prefix site` to import new captures from `site/shots-raw/`.
The importer converts other PNGs to WebP but preserves `ide-flex.png` byte-for-byte.
Crop bounds are calibrated to this capture (explorer 0–15%, Monaco 15–69%,
transcript 69–100%; top window chrome omitted in studies). Recheck these and
re-run browser tests if the source changes. The original remains unmodified.

## Design and interactions

- An editorial opening and a signal schematic: several surfaces resolve to one
  pi process plus extensions. Three surfaces cycle above the fixed pi engine;
  signals travel to native providers or Claude Code through `pi-claude-cli`.
  A keyboard-accessible native checkbox pauses/resumes the whole diagram.
- The IDE view is a whole, unmodified real screenshot. Two native radio controls
  select Claude Desktop–like and Codex app–like **layout studies** made from crops
  of that same image. They are explicitly not third-party screenshots, integrations
  or named presets that the app ships.
- The app's actual contract is one auxiliary pane, left/right docking, resizing
  and fullscreen, saved per session. Cropped layout studies illustrate that
  flexibility; they do not promise arbitrary editor splitting.
- Native radio controls also select real dark/light captures. Native `details`
  elements hold additional screenshots and technical reference material.
- CSS handles the surface cycle, provider signals, selection transitions and optional
  scroll-linked entrances. Base content is visible without JavaScript or modern
  animation support. Reduced motion removes animations and smooth scrolling.
- Each screenshot links to its full original for inspection. Astro emits
  responsive WebP variants; only the centrepiece is eager-loaded. Fonts are local.
- `src/styles/tokens.css` holds the site's design tokens, inherited unchanged
  from the previous page and aligned with `docs/style-guide.md`. The layout,
  copy, components and animation CSS are original.

## Feature / evidence map

Current feature docs are the authority; historical build specs are not treated
as shipped features. A reader-facing source index also lives at `#feature-index`.

| Page section  | Scope                                                                                                              | Evidence                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surface       | pi constant, per-session layout, left/right/fullscreen, independent panes                                          | [ui-shell](../docs/ui-shell.md), [architecture](../docs/architecture.md)                                                                                  |
| Models        | Native/package providers, API keys, local endpoints, model switches, thinking levels                               | [README](../README.md), [pi-integration](../docs/pi-integration.md), [chat](../docs/chat.md)                                                              |
| Subscriptions | ChatGPT Plus/Pro; Claude Pro/Max via Claude Code; Copilot; Kimi For Coding                                         | [settings / Accounts](../docs/settings.md#accounts), [CLI providers](../docs/cli-providers.md); checked against `electron/pi/auth-status.ts`              |
| Accounts      | Multiple Claude logins; specific/ordered/round-robin new-session routing; moving a lane respawns it                | [settings / Accounts](../docs/settings.md#accounts)                                                                                                       |
| MCP           | Curated/custom servers, adapter-owned OAuth, on-demand schema discovery, direct-tools exception                    | [MCP](../docs/mcp.md), [extensions](../docs/extensions.md)                                                                                                |
| Context       | pi total, estimated components, unmeasured CLI overhead, MCP attribution, reported cost and Claude account windows | [chat / Context meter](../docs/chat.md#what-the-context-meters-popover-shows)                                                                             |
| Lanes         | Board/ledger, sessions with branches/worktrees/PR status, search, local merge                                      | [README / Home](../README.md#home--where-a-session-starts), [overview](../docs/overview.md), [lanes](../docs/lanes.md), [worktrees](../docs/worktrees.md) |
| Transcript    | Steps, diffs, rich content, steering/follow-up queues, mentions, commands, shell lines, drafts                     | [chat](../docs/chat.md), [extensions / Provider transcripts](../docs/extensions.md#how-provider-transcripts-render)                                       |
| Files         | Explorer transfers, Monaco tabs, dirty/conflict states, fullscreen                                                 | [files](../docs/files.md), [ui-shell](../docs/ui-shell.md)                                                                                                |
| Terminal      | Separate real PTY, shell tabs, search/clipboard/scrollback, paste-not-execute                                      | [terminal](../docs/terminal.md)                                                                                                                           |
| Artifacts     | Versions/previews/diffs, replay, global index, networkless HTML sandbox                                            | [extensions](../docs/extensions.md), [ui-shell](../docs/ui-shell.md), [README](../README.md)                                                              |
| Extensions    | npm/Git/local packages, project/global scope, tools/skills/prompts/themes, six bundled extensions                  | [extensions](../docs/extensions.md), [settings](../docs/settings.md)                                                                                      |
| Sessions      | Real pi files/processes, tree/bookmark/fork/clone/export, concurrent streaming, compaction/retry                   | [README](../README.md), [pi-integration](../docs/pi-integration.md), [ui-shell](../docs/ui-shell.md)                                                      |
| Themes        | Light/dark/system, fonts and sizing                                                                                | [style guide](../docs/style-guide.md), [settings](../docs/settings.md)                                                                                    |
| Install       | Node/pi prerequisite, release assets and installer, Windows tagged releases, install-specific updates              | [README / Install](../README.md#install), [updates](../docs/updates.md)                                                                                   |

### Deliberate limits in the copy

No universal account failover, unlimited subscriptions, automatic GitHub PR
merge, fully local inference, universal agent sandbox or guaranteed token
savings. Component token sizes are estimates, not measurements. Claude-native
markers do not carry result bodies. Account routing is Claude-specific; moving
a live lane restarts it and re-reads saved history. PR integration uses `gh`
read-only; the guided merge is local. Installed packages execute code with
system access. Artifact isolation is a different boundary.

## Assets

Real screenshots live in `site/src/assets/shots/`. To reshoot, use the live
capture runner from the repo root (it spends real tokens and leaves sessions):

```bash
npm run build
OUT_DIR=site/shots-raw MAX_WIDTH=0 WORKSPACE=/path/to/project \
  node scripts/capture-live-shots.mjs
npm run shots --prefix site
```

Review/redact captures before importing or committing them. The Accounts image
is already redacted; preserve that redaction. The full IDE capture is manually
supplied rather than generated by the live runner. The brand favicon is
`build/icon.svg`; fonts and their OFL licenses are bundled under `public/fonts/`
from `src/assets/fonts/` in the repo root. The header, footer and tab use the
canonical beacon favicon. The social preview composites that same file rather
than maintaining a second drawing; `npm run build` regenerates it automatically.
Browser tests compare the served mark pixels against the favicon. To regenerate
and commit the preview after a brand change without a full build:

```bash
node site/scripts/social.mjs
```

## Deployment

The Docker builder runs Astro check before building, in an isolated context
without the repository root's dependencies. Its build stage also installs
DejaVu fonts for the social preview's SVG text; no system fonts are added to the
nginx runtime. `nginx.conf` and `.infra/phosphor-site/` are unchanged from the
original deployment: same namespace, immutable image digest, port 5015,
unprivileged nginx, read-only root filesystem, probes, resource limits and
rollout verification. No second Service or hostname is created.

`.github/workflows/deploy-site.yml` builds Docker context `./site` on pushes to
`main` touching `site/**`, `.infra/phosphor-site/**` or the workflow. It pushes
`saccodigital/phosphor-site:<sha>`, pins the k3s deployment to the image digest,
and verifies rollout. The existing edge route for **phosphor.saccolabs.com**
continues to point to the same Service on port 5015, so merging updates the page
at that address with no DNS or infrastructure migration.

The workflow waits for the Service to get its node address and prints it,
because a Pending Service means a port collision and `rollout status` cannot
see one — without that wait the run reports a green deploy nobody can reach.

Two things live outside the repo, both listed in the workflow header:

1. Four repository secrets — `DOCKER_HUB_USER`, `DOCKER_HUB_PASSWORD`,
   `TS_AUTH_KEY`, `ULTRON_KUBE_CONFIG`. The repo is public, but the workflow
   only runs on pushes to `main`, so forks never see them.
2. The edge route for `phosphor.saccolabs.com` → the node on port 5015, in
   whatever fronts the cluster. Nothing in this repo can create it.

CI installs, checks, builds and browser-tests this one canonical site. The
previous implementation is in git history, not a second build directory.
