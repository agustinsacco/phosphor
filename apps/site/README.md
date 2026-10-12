# phosphor.saccolabs.com

The production site is Astro 7 and Tailwind 4, with static HTML and **no shipped
JavaScript**. One deployment serves the landing and four user guides.

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

Run these examples from the repository root. The site retains its own manifest,
lockfile and installation; root `npm ci` installs Desktop, not the site. Root
aliases `site:install`, `site:dev`, `site:check`, `site:build` and `site:test`
delegate to the commands above. Nx site targets use this same independent package
and remain uncached. The [installation contract](../../docs/installations.md)
explains why the root source-library workspaces do not include the site or alter
its independently resolved toolchain and Docker context.

Playwright serves the production build on `127.0.0.1:4322`. It checks all five
pages on desktop, mobile, JavaScript-disabled desktop/mobile, and reduced
motion. Tests cover internal page/fragment destinations, linked capture assets,
images, canonical metadata, native layout controls, keyboard access, enlarged
text, 320–1920px overflow, and zero client scripts. CI runs this suite against
the production nginx image. `SITE_TEST_URL` can target an already-running site.

The external-link audit is separate from deterministic browser tests. It reads
links from built pages, follows HTTP redirects, checks GitHub Markdown fragments
against rendered heading slugs, and fails on unavailable destinations. It needs
network access; rate limits are failures to investigate, not successful checks.

To exercise the production image locally without deployment:

```bash
docker build -t phosphor-site-local ./apps/site
docker run -d --name phosphor-site-local --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /var/cache/nginx:rw,uid=101,gid=101 --tmpfs /tmp:rw,uid=101,gid=101 \
  -p 127.0.0.1:4322:5015 phosphor-site-local
SITE_TEST_URL=http://127.0.0.1:4322 npm test --prefix apps/site
docker rm -f phosphor-site-local
```

Use an unused local container name and port if another instance is running.
The image-only suite also checks direct guide-directory resolution with or without
a trailing slash (200, no redirect), cache and security headers, static fonts/assets,
and real 404 responses. The runtime is
non-root with a read-only filesystem; only its nginx cache and `/tmp` are writable.

Formatting Astro files explicitly loads the plugin:

```bash
npm run format --prefix apps/site
```

## Narrative and routes

- `/`: parallel work, inspectable edits and artifacts, provider choice, optional
  pi packages, and a visible eight-service connector catalog. Four numbered
  benefits, then a getting-started handoff.
- `/guides/`: installation, sign-in choices, a first verifiable task, permissions,
  and troubleshooting.
- `/guides/claude-code/`: CLI and provider prerequisites, installation, login,
  provider test, multiple accounts, routing, and failure recovery.
- `/guides/extensions/`: included versus optional capabilities, five recommended
  packages, scope, trust, and updates.
- `/guides/connectors/`: adapter installation, authorization, Test, per-service
  requirements, custom servers, and permissions.

`src/lib/content.ts` owns the guide links, package specs/source destinations,
and connector summaries. Guides link to the living technical contracts rather
than replacing them. Screenshots and text must be checked against settings UI
when it changes. `docs/settings.md`, `docs/cli-providers.md`, `docs/extensions.md`,
and `docs/mcp.md` are the relevant contracts.

## Captures and privacy

The landing opens with one lane running four sub-agents at once. That capture
is a **scripted demo**, labelled “Demo session · scripted agents” on the page:
the deterministic `npm run shots` runner drives the built app against the e2e
pi stub, which holds a `parallel` sub-agent call mid-run. No model, key or
network is involved. To regenerate it:

```bash
npm run build
OUT_DIR=apps/site/shots-raw MAX_WIDTH=0 ONLY=subagents npm run shots
npm run shots --prefix apps/site
```

After it come the lane dashboard, a chat-focused session, and an IDE-style
editor-and-agent view to show the layout flexibility. Those three are real
captures, visible without opening a disclosure. The hero stays uncropped on
desktop and mobile; every image links to its full-size original.
Native radios in “Explore more layouts” show actual right-docked, left-docked,
and fullscreen pane captures. There are no third-party replicas or implied presets.

The four `guide-*.webp` files are actual settings UI rendered with **fictional
browser-harness data**, labelled as demos on every use. No live account store,
credential, browser profile, or Electron instance is read. Account labels are
Account A/B and addresses are masked example addresses before pixels are
captured. Versions and usage are illustrative, not current-version claims.

To regenerate from this checkout:

```bash
npm ci
npm run dev:web -- --host 127.0.0.1 --port 5199
# In another terminal:
npm run shots:guides --prefix apps/site
```

`GUIDE_HARNESS_URL` may select another localhost port. The capture script launches
a fresh isolated browser, blocks external requests, substitutes fixture account
and server data, and re-encodes images without metadata. It captures only the
settings modal. Inspect every generated image before committing it. Both the
responsive previews and the full-size linked originals use these safe files;
there is no CSS-only blur concealing a downloadable unredacted original.

Existing live captures can still be imported with `npm run shots --prefix apps/site`.
Review and redact new live captures before import. `ide-flex.png` is the original
supplied editor-and-agent capture, shown after the chat-focused view. Its layout
is not a composite or a rearranged screenshot.

## Behavior and limits

All navigation uses ordinary links. Disclosures and layout radios work without
JavaScript. Local fonts, responsive Astro images, and existing Phosphor tokens
keep the site aligned with `docs/style-guide.md`. Reduced motion disables smooth
scrolling. Guides have page-specific titles/descriptions/canonicals and visible
navigation on narrow screens.

Do not promise universal account failover, unlimited subscriptions, a cloud
runner, automatic GitHub merges, or an agent sandbox. Claude routing applies to
new sessions; moving a lane respawns it. Connector authorization/Test spends no
model tokens, but model-driven tool use can consume tokens and service quota.
Packages execute code with system access. Artifact isolation is a separate
boundary. Context components are estimates. Routines are local and need the
computer awake.

## Deployment and identity

The existing Docker/nginx image and `.infra/phosphor-site/` manifests serve this
one site on port 5015. Deploy Site retains path-filtered main pushes for
`apps/site/**`, `.infra/phosphor-site/**`, its workflow and deployment-policy helpers.
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
the hold. Rejected manual refs cannot cancel production work. The workflow
rechecks that its SHA is still current main before publishing the image and
before rollout, including after any `site-production` environment approval.

CI tests the site before Deploy Site builds the immutable image, pins its
digest and verifies rollout. The image name, namespace, port and environment
remain unchanged. There is no second site or new routing service. nginx
resolves guide directories to their `index.html`. The edge route and four
deployment secrets remain external configuration.

The header/footer favicon and social preview use the canonical beacon.
`npm run build` regenerates `public/og.png` from `scripts/social.mjs`; browser
tests compare its mark pixels with the favicon. The site title, description,
social text, and visible opening should tell the same story.
