# phosphor.saccolabs.com

The original Phosphor landing page: one Astro 7 page, Tailwind 4 over the
Phosphor design tokens, no client framework. Preserved as the previous design
and source-capture directory. The replacement is [site_v2/](../site_v2/README.md),
which uses the same nginx/k3s contract with a new page and components.

## Local development

```bash
npm ci --prefix site
npm run dev --prefix site        # http://localhost:4321
npm run check --prefix site      # astro check
npm run build --prefix site      # writes site/dist
```

The root `prettier --check .` covers this folder with the repo's config.

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

The workflow now builds from `site_v2/`, triggered by changes there, to
`.infra/phosphor-site/**` or to the workflow itself. It requires the exact IDE
capture before publishing. It builds `saccodigital/phosphor-site:<sha>`, pushes it, then applies
`.infra/phosphor-site` with the image pinned to the pushed digest and wait for
the rollout. The Service is `type: LoadBalancer` on port **5015** (unique per
site — k3s servicelb binds it on the node), so the edge needs a route from
`phosphor.saccolabs.com` to that port. Secrets and the one-time edge setup are
listed in the workflow header and in
`docs/log/2026-09-09-landing-site.md`.
