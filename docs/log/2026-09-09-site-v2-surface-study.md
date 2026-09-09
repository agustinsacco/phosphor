# A second landing page: the agent stays, the surface changes

`site_v2/` is a new Astro 7 / Tailwind 4 landing page, not a restyle of the
original components. It reuses the original site's tokens, real captures, local
fonts and deployment contract. No client framework or JavaScript ships.

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
and caveats are in [site_v2/README.md](../../site_v2/README.md). Settings now
explicitly documents the four subscription routes that its provider registry
already supports.

## The supplied IDE capture and animated provider relationship

The exact IDE file was absent from the initial worktree. During review, the
user supplied the full 6012 × 3322 capture of Headroom Optimization, with
Claude Opus 5, the results table, Monaco and the composer. It is saved unchanged
as `site/src/assets/shots/ide-flex.png` and copied into `site_v2/`. The temporary
fallback and its warning are removed; study crops are calibrated to the supplied
image. The captured table is historical session output, not a benchmark claim.

The hero now cycles the three surfaces and sends CSS signals through the fixed
pi engine to native providers or Claude Code via `pi-claude-cli`. A native
pause/resume checkbox works without JavaScript; reduced motion stops the diagram.
The copy distinguishes pi's supplied context/skills/extension tools from Claude's
own native tools, authenticated subscription and persistent process.

## Deployment and checks

The existing workflow changes its Docker context to `site_v2/`; Dockerfile,
nginx config and `.infra/phosphor-site/` remain the same. It uses the existing
Service rather than creating a conflicting second port 5015 binding.

CI checks/builds both Astro sites and runs the v2 browser suite: desktop,
mobile, no-JavaScript desktop/mobile and reduced motion. Tests cover native
controls, keyboard navigation, screenshot loading, local asset responses,
internal links, viewport overflow and browser errors. Screenshots are uploaded
as CI evidence. The Electron app and its IPC/session behavior are unchanged.
