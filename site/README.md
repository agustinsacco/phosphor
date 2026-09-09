# phosphor.saccolabs.com

The Phosphor landing page: one Astro 7 page, Tailwind 4 over the Phosphor design
tokens (a hand-mirrored satellite of `src/styles/index.css` — see
`docs/style-guide.md`), no client framework. Built into an nginx image and
deployed to the k3s cluster by `.github/workflows/deploy-site.yml`.

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

Pushes to `main` that touch `site/**`, `.infra/phosphor-site/**` or the workflow
build `saccodigital/phosphor-site:<sha>`, push it, then apply
`.infra/phosphor-site` with the image pinned to the pushed digest and wait for
the rollout. The Service is `type: LoadBalancer` on port **5015** (unique per
site — k3s servicelb binds it on the node), so the edge needs a route from
`phosphor.saccolabs.com` to that port. The workflow waits for the Service to
get its node address and prints it, because a Pending Service means a port
collision and `rollout status` cannot see one — without that wait the run
reports a green deploy nobody can reach.

Two things live outside the repo, both listed in the workflow header:

1. Four repository secrets — `DOCKER_HUB_USER`, `DOCKER_HUB_PASSWORD`,
   `TS_AUTH_KEY`, `ULTRON_KUBE_CONFIG`. The repo is public, but the workflow
   only runs on pushes to `main`, so forks never see them.
2. The edge route for `phosphor.saccolabs.com` → the node on port 5015, in
   whatever fronts the cluster. Nothing in this repo can create it.
