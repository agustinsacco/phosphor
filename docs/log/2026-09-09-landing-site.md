# A landing page at phosphor.saccolabs.com — 2026-09-09

Phosphor had a README and nothing else facing outward. This adds `site/`, a
single-page Astro site that presents the product — every provider, the
subscription sign-in story, the account/MCP/context gateways, the transcript,
lanes, the three panes, connectors, extensions, sessions, the process model,
themes and install — with live screenshots, plus the workflow and manifests
that put it on the k3s cluster next to tars.saccolabs.com.

## Shape

- **Structure and deploy are tars's.** `site/` mirrors `tars/site` (Astro +
  Tailwind 4, nginx image, unprivileged read-only container), and
  `.github/workflows/deploy-site.yml` is `deploy-docs.yml` with the names
  changed: build by SHA, push, kustomize, pin the digest, wait for rollout.
  React islands were dropped — a landing page needs two `<script>` tags, not a
  framework.
- **Design is Phosphor's.** `site/src/styles/global.css` mirrors the dark
  `--px-*` tokens by hand (the style guide's satellite rule applies: change a
  neutral in `src/styles/index.css` and this file is part of the diff). Mono
  eyebrows, the electron-shell mark, the Beacon, the `▍` cursor and the
  180ms-class motion all come straight from the app. The mark is inline SVG so
  its 2 · 8 · 5 electrons can orbit; the shells and the P never move.
- **Screenshots are real.** `scripts/capture-live-shots.mjs` grew two env
  knobs, `OUT_DIR` and `MAX_WIDTH` (`0` keeps the device-scale capture), so the
  same runner that shoots the README shoots the site at 2880×1840. The captures
  are the Phosphor repo itself as the workspace, two metered turns (GPT-5.5 on a
  ChatGPT plan, Claude Fable 5 through pi-claude-cli), and the workspace's real
  lanes in the sidebar. Committed as WebP q90 (3.5 MB for 17 shots), imported
  by `npm run shots --prefix site`.
- The runner's Connectors selector had gone stale (the tab was renamed to
  "MCP Connectors" when the tabs merged); fixed here, which is also why the
  README's own shots would have failed to regenerate.
- **The social card is the hero.** `site/public/og.png` is the built page's
  hero at 1440 wide, cropped to 1200×630; the layout emits `og:image` and
  `twitter:card` for it. Re-cut it when the hero copy changes.
- **CI builds the site on every PR** (`site` job in `ci.yml`: `astro check` +
  `astro build`). The deploy workflow only runs after a merge, so without this
  a broken page would first fail on main.

## Cluster

Same pattern as every other site on the box: a `type: LoadBalancer` Service on
a **port unique to the site** (`5015`, element 15 — tars is 5252, lattice
3010), because k3s servicelb binds the port on the node and the edge routes
hostnames to node ports. Unlike tars's workflow, this one also waits for the
Service to get its node address and prints it: a Pending Service is a port
collision, `rollout status` cannot see it, and the run fails instead of
reporting a green deploy nobody can reach. The image is public on Docker Hub (as `tars-docs` is);
the `docker-registry-key` pull secret is copied from the `tars` namespace on
first deploy only if it exists there, and only to dodge the anonymous rate
limit.

What the deploy needs that this PR cannot provide:

1. Four repository secrets on `agustinsacco/Phosphor`, identical to tars's:
   `DOCKER_HUB_USER`, `DOCKER_HUB_PASSWORD`, `TS_AUTH_KEY`, `ULTRON_KUBE_CONFIG`.
   Secret values are write-only in GitHub, so they have to be re-entered, not
   copied. The Phosphor repo is public; the workflow runs only on pushes to
   `main`, so forks never see them.
2. An edge route for `phosphor.saccolabs.com` → the node on port `5015`, in
   whatever fronts tars (Cloudflare proxies the hostname; the tunnel/ingress
   config lives outside the repos). There is no DNS record for the hostname
   yet.

The `site-production` environment is created by GitHub on the workflow's first
run (tars's is `documentation-production`); no protection rules.

## Not done

- No `/docs` section. The README and `docs/` remain the documentation; the
  site links to them. A docs section is a content project, not a build one.
- The README's screenshots still show the pre-rename `pidex` chrome. They can
  be regenerated with `npm run shots:live` now that the runner works again;
  left out of this PR to keep the diff to the site.
