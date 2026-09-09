# phosphor.saccolabs.com

The Phosphor website: four static Astro 7 pages, shared semantic CSS over the
existing brand tokens, locally hosted fonts, responsive real-app screenshots,
and no client framework. Tailwind 4 supplies the CSS reset; page composition
uses the role classes in `src/styles/global.css`. Built into the existing nginx
image and deployed by `.github/workflows/deploy-site.yml`.

**The working record** is the website design language: slate paper for reading,
graphite for working passages, numbered margins, and real evidence. See
[`docs/site-design.md`](../docs/site-design.md) for the audience, grammar, and
plain-language iteration rules; [`docs/style-guide.md`](../docs/style-guide.md)
remains authoritative on brand colors, fonts, and the mark.

| Page         | Job                                                                   |
| ------------ | --------------------------------------------------------------------- |
| `/`          | Introduce the human-agent working loop and show the actual app        |
| `/workbench` | Explain workflows, artifacts, lanes, providers, and extensions        |
| `/download`  | Platform downloads, prerequisites, commands, and execution boundaries |
| `/design`    | Public design-language reference for this and future pages            |

`BaseLayout` owns metadata, navigation, skip link, and footer. `Shot` owns
responsive images and full-size links. `Evidence` progressively enhances three
figures into keyboard-operable tabs; without JS every figure is visible.
`CopyCommand` announces success or selects the command for manual copying when
the clipboard is unavailable. No other browser-side behavior is required.

## Local development

```bash
npm ci --prefix site
npm run dev --prefix site        # http://localhost:4321
npm run check --prefix site      # astro check
npm run build --prefix site      # writes site/dist
npm exec --prefix site -- playwright install chromium
npm test --prefix site           # rebuild + desktop/mobile browser and axe checks
npm run social-image --prefix site # rebuild public/og.png from the site's fonts/tokens
```

The browser suite owns a preview server on port 4322; use 4321 for manual review.
It checks all routes, links, metadata, image delivery, keyboard interactions,
clipboard denial, no-JS behavior, reduced motion, and responsive overflow.
CI also runs it. On a fresh Linux machine, install Chromium's system libraries
with `playwright install --with-deps chromium`.

The root `prettier --check .` covers standard file types with the repo's config;
it does not load the Astro plugin. Use `npm run format --prefix site` for Astro
files and `npm run format:check --prefix site` to check them (also run in CI).
The social-image generator is fully local and requires only the installed
Playwright browser, not a running server.

## The screenshots

Every image under `src/assets/shots/` is a capture of the built app running
against a **real pi** — the same runner the README uses, aimed here and kept at
the display's native scale:

```bash
npm run build
OUT_DIR=site/shots-raw MAX_WIDTH=0 WORKSPACE=~/src/agustinsacco/Phosphor \
  node scripts/capture-live-shots.mjs
npm run shots --prefix site      # shots-raw/*.png → src/assets/shots/*.webp
```

The run spends real tokens (two turns plus auto-naming) and leaves two sessions
and one worktree behind, like the README runner does. `shots-raw/` is
gitignored; the committed sources are the WebP files, and Astro's `<Image>`
derives every responsive width from them at build time.

**Review the captures before committing them.** The sidebar shows the
workspace's real lanes and the Accounts tab shows which account is signed in.
The published `accounts.webp` has the account email blurred by hand
(ImageMagick `-region … -blur`); redo that if you re-shoot it.

## Deployment

Pushes to `main` that touch `site/**`, `.infra/phosphor-site/**` or the workflow
build `saccodigital/phosphor-site:<sha>`, push it, then apply
`.infra/phosphor-site` with the image pinned to the pushed digest and wait for
the rollout. The Service is `type: LoadBalancer` on port **5015** (unique per
site — k3s servicelb binds it on the node), so the edge needs a route from
`phosphor.saccolabs.com` to that port. Secrets and the one-time edge setup are
listed in the workflow header and in
`docs/log/2026-09-09-landing-site.md`.
