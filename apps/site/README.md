# phosphor.saccolabs.com

Astro static HTML with **no shipped client JavaScript**. Native links, disclosures,
layout radios and video controls work without hydration or third-party embeds.
The site and control API share a production image; the Host-backed PWA is a
separate client, not this marketing site.

## Run and check

```bash
npm ci --prefix apps/site
npm run dev --prefix apps/site
npm run check --prefix apps/site
npm run build --prefix apps/site
(cd apps/site && npx playwright install chromium)
npm test --prefix apps/site
npm run audit:links --prefix apps/site
```

Use a Node version supported by the pinned Astro release (currently ≥22.23.4).
The site owns its manifest, lockfile and install; root aliases `site:install`,
`site:dev`, `site:check`, `site:build`, `site:test` delegate here. Nx targets use
that independent package and remain uncached. See [installations](../../docs/installations.md).

Playwright serves the production build on `127.0.0.1:4322` and checks all eleven
routes on desktop, mobile, JS-disabled desktop/mobile and reduced motion. It
covers local links/fragments, full-size capture assets, metadata, native controls,
keyboard access, enlarged text, 320–1920px overflow and zero client scripts.
`SITE_TEST_URL` targets an already-running production image; image-only checks
cover directory routes, cache/security headers, redirects, media and real 404s.
The external-link audit is separate and requires network access.

To exercise the combined image locally without deployment:

```bash
bash tools/scripts/site-image.sh
```

It creates an isolated container on an unused local port and removes it on exit.
The runtime is Node 22 as uid 1000, with a read-only filesystem, no writable
volumes and all capabilities dropped. Formatting explicitly loads Astro's plugin:

```bash
npm run format --prefix apps/site
```

## Narrative and routes

- `/`: “Your work. In context.” Current workbench, inspectable lanes, Brain,
  PR/Slack links, Machines/PWA, Swarm, models, packages, connectors and install.
- `/guides/`: local installation, provider sign-in, a verifiable first task,
  Host/PWA alternatives, permissions and troubleshooting.
- `/guides/daily-work/`: lane/worktree workflow, Files/Changes, models/context,
  multi-PR inspection, Slack links, notifications, snapshot moves, Brain,
  subagents, artifacts, history, routines, skills and machine-scoped settings.
- `/guides/brain/`: Desktop opt-in/model download, explicit queueing, saved
  reads with Undo, sentence walks, Brain Agent checks, recall, provider costs
  and retention.
- `/guides/machines/`: private Tailscale setup, enrollment/readiness, provider
  configuration, explicit lane control, browser/PWA limits and snapshot moves.
- `/guides/swarm/`: authorization, inherited branch decisions, bounded delegation,
  independent review and a historical public Remote Hosts development example.
- `/guides/accounts/`: provider plans, Claude prerequisites, sign-in, new-session
  routing, explicit account switching, machine scope and recovery. The old
  `/guides/claude-code/` redirects here; its useful fragments remain.
- `/guides/extensions/`: bundled versus optional behavior, four package choices,
  installation, machine/folder scope, trust and updates.
- `/guides/connectors/`: pi-native MCP, machine-scoped configuration, service
  requirements including Google Workspace preview and Slack app registration.
- `/watch/`: three silent text-led films with native controls, local posters,
  written steps and guide handoffs. No autoplay, external player or client runtime.
- `/privacy/`: site logs/download counts, provider requests, Brain, direct Host
  transport, optional accounts/cookies, service boundaries and deletion limits.

`src/lib/content.ts` owns guide links, explicit capture imports, package sources
and connector summaries. `src/lib/films.ts` owns film metadata and written steps.
Guides link to living contracts instead of duplicating implementation detail.
Useful old section IDs remain addressable. CSS is split into base, shell,
marketing, captures and guide reading surfaces; each source file stays ≤400 lines.

## Captures and privacy

Refreshed screenshots are **Product demo · fictional data** in actual product
surfaces, not real user sessions, current provider usage or benchmarks. Every
full-size original must be public-safe; responsive previews are not a redaction
boundary. The explicit import allowlist prevents accidentally publishing unused
historical account/settings captures. Never replace it with an asset glob.

The refresh covers existing site shots and repository `docs/img/` gallery plus
Brain setup/graph, PR inspector, Slack pills, Machines, mobile and notifications.
[Capture tooling and fixtures](scripts/CAPTURES.md) document reproduction, the
fictional Harbor Brain dataset and the complete asset inventory. Do not
use live session files, credential stores, a real Host enrollment, provider calls
or live screenshot utilities to regenerate these demo assets. Inspect full-size
pixels and metadata before publication. `ide-flex.png` retains its existing name
because repository/deployment checks use that path.

The historical Remote Hosts case study remains public prose and PR links. It is
not the provenance of the refreshed fixture images, and no speedup, model ranking
or automatic acceptance is inferred from either.

## Films

The native video surface expects these self-hosted files, each with a matching
same-stem `.webp` poster under `public/media/`:

- `phosphor-overview.mp4`
- `brain-walkthrough.mp4`
- `lane-to-review.mp4`

Rendered Hyperframes assets keep their editable sources and reproduction steps
under `tools/marketing/`.
The site imports no Hyperframes player or runtime. `<video controls preload="none">`
never autoplays or loops. Silent text-led content has visible equivalent steps,
not an audio-only lesson. Posters and source videos must use public-safe demo
fixtures; neither private recordings nor reconstructed live-performance claims.
The control server owns MIME/range serving, independently tested there.

## Behavior and limits

Keep Desktop, Host and browser capabilities distinct. Brain is Desktop-only and
off by default; local embeddings/storage do not make provider extraction offline.
Reads save when they finish; every saved read and Brain Agent change has Undo.
Nothing syncs Brain between machines.
The PWA has no local lanes, native editor, split panes or scripted HTML preview.

PR actions draft rather than send; GitHub stays read-only. Track/Hide is local-live
only, while current Hosts support inspector detail. Slack pills are transcript
links, not Slack sync. Moves retain the original snapshot and do not copy credentials
or processes. Notifications are memory-only; routines have separate durable history.
Swarm authorizes delegation, not a fixed team, automatic model roles or merge.

Provider terms/quotas apply. Package tools run with system access. Worktrees are
not sandboxes. Context component sizes are estimates. Host execution needs your
own machine awake and runtime running, not a cloud subscription. Current Desktop
releases are macOS/Linux; there is no Windows build.

## Deployment and identity

The combined image in `apps/control/Dockerfile` and `.infra/phosphor-site/`
manifests serve this site and the control API on port 5015. Deploy Site retains path-filtered main pushes for
`apps/site/**`, `apps/control/**`, `libs/shared/src/**`, the image-check script,
`.infra/phosphor-site/**`, its workflow and deployment-policy helpers.
It waits up to thirty minutes for successful CI from this repository's main push
at the exact checked-out SHA. Missing, failed, cancelled or unverifiable CI
cannot deploy. GitHub's push-range path filter includes multi-commit pushes;
PR CI completions never trigger or cancel production deployment.

The actual commit's `Skip-Release: true` trailer also holds site deployment
using the Desktop release trailer parser. The repository variable
`SITE_DEPLOY_HOLD` permits deployment only when absent/empty or literally
`false`; every other value holds it. Structural migration commits retain the
trailer. Manual operation requires selecting `main`, explicitly checking
`confirm`, and passing the same exact-SHA CI and hold checks. It does not bypass
the hold. A confirmed manual run may also check `ignore_skip_release` to deploy
past the trailer; pushes always honour it, and the hold and CI checks still apply. Rejected manual refs cannot cancel production work. The workflow
rechecks that its SHA is still current main before publishing the image and
before rollout, including after any `site-production` environment approval.

CI tests the site before Deploy Site builds the immutable image, pins its
digest and verifies rollout. The image name, namespace, port and environment
remain unchanged. There is no second site or new routing service. The Node server
resolves guide directories to their `index.html`. Six repository secrets supply
registry access, Tailscale, Kubernetes credentials, the Supabase RPC key and the
shared Cloudflare edge header. Deploy validates and renders the last two into a
Secret manifest under `RUNNER_TEMP`, applies it and deletes the file. Public URL
checks require the site, liveness and a configured API within two minutes.
See [control-plane.md](../../docs/control-plane.md#image-and-deployment).

The header/footer favicon and social preview use the canonical beacon.
`npm run build` regenerates `public/og.png` from `scripts/social.mjs`; browser
tests compare its mark pixels with the favicon. The site title, description,
social text, and visible opening should tell the same story.
