# A second landing page: the agent stays, the surface changes

The new Astro 7 / Tailwind 4 landing page was developed in `site_v2/`, then
promoted into canonical `site/` after review. It is not a restyle of the original
components; it reuses their tokens, real captures, local fonts and deployment
contract. No client framework or JavaScript ships.

The centrepiece switches between the real left-docked IDE capture and two
explicitly labelled layout studies, using native radio controls and CSS. The
studies crop the same session into Claude Desktop–like and Codex app–like
arrangements; they are not integrations or promises of named app presets.
A second native group switches between real light/dark captures. Technical
reference and extra captures use native disclosures.

The page covers models and subscription routes, Claude account routing, MCP
and context gateways, lanes/branches/worktrees/PR status, the transcript and
composer, files, terminal, artifacts, extensions, session history, themes and
install. Each section links to current feature docs; the complete claim map
and caveats are in [site/README.md](../../site/README.md). Settings now
explicitly documents the four subscription routes that its provider registry
already supports.

## The supplied IDE capture and animated provider relationship

The exact IDE file was absent from the initial worktree. During review, the
user supplied the full 6012 × 3322 capture of Headroom Optimization, with
Claude Opus 5, the results table, Monaco and the composer. It is saved unchanged
as `site/src/assets/shots/ide-flex.png`. The temporary
fallback and its warning are removed; study crops are calibrated to the supplied
image. The captured table is historical session output, not a benchmark claim.

The hero now cycles the three surfaces and sends CSS signals through the fixed
pi engine to native providers or Claude Code via `pi-claude-cli`. A native
pause/resume checkbox works without JavaScript; reduced motion stops the diagram.
The copy distinguishes pi's supplied context/skills/extension tools from Claude's
own native tools, authenticated subscription and persistent process.

## Deployment and checks

Promotion restores `site/**` as the workflow trigger and `./site` as the Docker
context. The separate `site_v2/` directory and duplicate CI matrix are removed;
the original page remains in Git history. The nginx runtime and
`.infra/phosphor-site/` remain the same, so the existing
`phosphor.saccolabs.com` edge route still reaches the same Service on port 5015.
The screenshot importer again reads raw captures, not another site's directory,
and preserves the supplied IDE PNG unchanged.

CI checks/builds the canonical site and runs its browser suite: desktop,
mobile, no-JavaScript desktop/mobile and reduced motion. Tests cover native
controls, keyboard navigation, screenshot loading, local asset responses,
internal links, viewport overflow and browser errors. Screenshots are uploaded
as CI evidence. Promotion was also validated by building Docker context `./site`
and serving the image as UID 101 with a read-only root and all capabilities
dropped: the page, immutable CSS, font license and social image returned
successfully. The raw-capture importer was checked for WebP conversion and
byte-identical IDE PNG preservation. The Electron app and its IPC/session
behavior are unchanged.

CI exposed a missing site-local `@types/node` dependency: local Astro checks
silently resolved it from the root install. Added the Node 22 types explicitly
and made the Docker builder check before building. Reproduced the four errors
in a standalone `/tmp` checkout; after the fix, its clean install, Astro check,
build and all 25 browser tests (`CI=1`) passed, as did the isolated Docker build.
