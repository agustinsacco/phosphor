# phosphor.saccolabs.com

The production site is Astro 7 and Tailwind 4, with static HTML and **no shipped
JavaScript**. One deployment serves the landing and four user guides.

## Run and check

```bash
npm ci --prefix site
npm run dev --prefix site
npm run check --prefix site
npm run build --prefix site
(cd site && npx playwright install chromium)
npm test --prefix site
npm run audit:links --prefix site
```

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

Formatting Astro files explicitly loads the plugin:

```bash
npm run format --prefix site
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

The landing's workflow/editor captures are real sessions. Native radios show
actual right-docked, left-docked, and fullscreen pane captures. There are no
third-party layout replicas or implied presets. The hero uses a bounded crop of
the real Changes capture with its complete original available via the image link.

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
npm run shots:guides --prefix site
```

`GUIDE_HARNESS_URL` may select another localhost port. The capture script launches
a fresh isolated browser, blocks external requests, substitutes fixture account
and server data, and re-encodes images without metadata. It captures only the
settings modal. Inspect every generated image before committing it. Both the
responsive previews and the full-size linked originals use these safe files;
there is no CSS-only blur concealing a downloadable unredacted original.

Existing live captures can still be imported with `npm run shots --prefix site`.
Review and redact new live captures before import. The unused historical
`ide-flex.png` remains the original supplied capture; it is not the landing's
hero or evidence for rearranged layouts.

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
one site on port 5015. The Deploy Site workflow builds, tests, pins the image
digest, and verifies rollout on green main changes. There is no second site or
new routing service. nginx resolves guide directories to their `index.html`.
The edge route and four deployment secrets remain external configuration.

The header/footer favicon and social preview use the canonical beacon.
`npm run build` regenerates `public/og.png` from `scripts/social.mjs`; browser
tests compare its mark pixels with the favicon. The site title, description,
social text, and visible opening should tell the same story.
