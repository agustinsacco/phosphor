# Phosphor — surface study

An original landing page in `site_v2/`: Astro 7, Tailwind 4, static HTML, no
client framework and **no shipped JavaScript**. The existing `site/` layout,
copy and components are not reused.

## Run and check

```bash
npm ci --prefix site_v2
npm run dev --prefix site_v2
npm run check --prefix site_v2
npm run build --prefix site_v2
(cd site_v2 && npx playwright install chromium)
npm test --prefix site_v2
```

Playwright serves the production build on `127.0.0.1:4322`. It checks desktop,
mobile, JavaScript-disabled desktop/mobile and reduced motion; keyboard radio
navigation, native disclosures, image/asset responses, console and page errors,
internal anchors, 320–1920px overflow, enlarged layout, and zero client scripts.
Screenshots and failure traces go to the ignored `test-results/` directory. CI
runs this suite and uploads its evidence. Electron e2e is not the website's test
harness; no app, IPC or session behavior changes here.

Formatting Astro files explicitly loads the plugin:

```bash
npm run format --prefix site_v2
```

## The exact IDE capture

`site/src/assets/shots/ide-flex.png` is the original **6012 × 3322** full-window
capture supplied by the user during review, copied byte-for-byte into this
site's self-contained asset directory. It shows the Headroom Optimization
session: explorer and Monaco (`TopBar.tsx`) left, Claude Opus 5 transcript and
results table right, Max thinking and a 35% context meter in the composer.
The figures are historical session output, not a product benchmark.

The original input checkout lacked this file. The supplied attachment resolved
that dependency; the temporary GPT-5.5 fallback and its warning have been removed.
Build and deployment require the real capture.

Run `npm run shots --prefix site_v2` after updating the original source images.
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
- `src/styles/tokens.css` mirrors only the design-token prelude of
  `site/src/styles/global.css`. All other CSS and components are new.

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

Screenshot files are copied from `site/src/assets/shots/`, not re-created.
The source Accounts capture is already redacted; preserve that redaction.
The brand favicon is `build/icon.svg`. Fonts and their licenses come from the
existing site's local `public/fonts/` assets. Regenerate the original social
preview from the mirrored tokens with:

```bash
node site_v2/scripts/social.mjs
```

## Deployment

`Dockerfile` and `nginx.conf` are byte-for-byte copies of `site/`. The existing
`.infra/phosphor-site/` manifests remain unchanged: same namespace, immutable
image digest, port 5015, unprivileged nginx, read-only root filesystem, probes,
resource limits and rollout verification. No second Service competes for the
same node port.

The existing `.github/workflows/deploy-site.yml` keeps its pipeline shape and
secrets, but takes `site_v2/` as the Docker context and path trigger. Once the
capture prerequisite is met and the PR is merged, it replaces the existing
landing page at the same host. The old `site/` remains available as the previous
design and source-capture directory. Both Astro sites are checked and built in CI.
