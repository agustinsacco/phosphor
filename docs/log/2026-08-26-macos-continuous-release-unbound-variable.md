# 2026-08-26 — Every continuous release since #71 shipped no macOS build at all

Reported as: "the v0.1.93 releases page has no `.dmg`."

## What shipped

v0.1.93's assets: `checksums.txt`, `icon.png`, `install.sh`,
`latest-linux.yml`, `latest-linux-arm64.yml`, `Phosphor-0.1.93-amd64.deb`,
`Phosphor-0.1.93-arm64.deb`, `Phosphor-0.1.93-arm64.AppImage`,
`Phosphor-0.1.93-x86_64.AppImage`. No `.dmg`, no `.zip`, no `latest-mac.yml`.

## Root cause

`release-continuous.yml`'s macOS job never reached `electron-builder`. The
"Package and publish" step failed immediately:

```
line 26: HARDENED[@]: unbound variable
##[error]Process completed with exit code 1.
```

The step builds an array conditionally:

```sh
HARDENED=()
if [ "${RUNNER_OS}" = "macOS" ] && [ "${SIGNED}" = "true" ]; then
  HARDENED=(--config.mac.hardenedRuntime=true)
fi
npx electron-builder ${{ matrix.args }} --publish always \
  "${HARDENED[@]}" \
  ...
```

under `set -euo pipefail`. That is fine on bash ≥4.4, where expanding
`${arr[@]}` on a zero-length array yields zero words. `macos-latest` runners
still run Apple's own `/bin/bash`, frozen at 3.2.57 (the last GPLv2 release —
Apple has shipped zsh as the interactive default since Catalina and never
updated the bundled bash), where the identical expansion throws "unbound
variable" under `set -u`. Reproduced directly on that binary:

```
$ /bin/bash --version | head -1
GNU bash, version 3.2.57(1)-release (arm64-apple-darwin25)
$ /bin/bash -c 'set -u; a=(); echo "${a[@]}"'
bash: a[@]: unbound variable
```

`HARDENED` is only non-empty when `SIGNED=true`, which requires
`MAC_CERT_P12` — a secret this repo does not have configured. So every
unsigned macOS build (all of them) hit the empty-array case and failed before
`electron-builder` ran. `fail-fast: false` on the build matrix, plus
`finalize`'s `!cancelled()` gate (from the
[the previous stranded-release fix](2026-08-20-installer-arch-and-updater-esm.md)),
meant the Linux job's success alone still finalized and published a release —
so the pipeline kept going green-ish and nothing paged anyone. The failure was
only visible as a red macOS job inside an otherwise-successful workflow run,
and as a releases page quietly missing half its platforms.

`git log -p` on the workflow file: `HARDENED` was introduced in
[the ad-hoc signing fix](2026-08-24-mac-adhoc-signing.md) (#71, `807cb7a`),
the commit immediately before the one that produced v0.1.93. Every macOS
build since has failed this way; v0.1.93 is simply the first release built
after that commit landed on `main`.

## The fix

```sh
npx electron-builder ${{ matrix.args }} --publish always \
  "${HARDENED[@]+"${HARDENED[@]}"}" \
  ...
```

`${arr[@]+word}` only substitutes `word` when `arr` is set, regardless of
whether it has zero elements — so `${arr[@]+"${arr[@]}"}` expands to nothing
for an empty array and to the real elements otherwise, and it does not trip
`set -u` on either bash 3.2 or 4.4+. Verified directly against
`/bin/bash` 3.2.57 for both the empty and populated cases; only the old
`"${HARDENED[@]}"` form threw.

## What this does not fix

This only stops the crash; it does not retroactively add a `.dmg` to any
release already published (v0.1.93 and whatever shipped between #71 and this
fix). The next green CI run on `main` after this merges will produce the next
continuous release with macOS assets restored — `workflow_run` triggers only
read the workflow file from the default branch, so this has no effect until
merged. A `workflow_dispatch` run of `release-continuous.yml` on `main` can
be used to force one sooner without waiting for another commit.

## The gap this leaves

Nothing in CI currently fails the _workflow run_ when one platform in the
release matrix fails — by design, so a red macOS job doesn't strand Linux's
artifacts (see `finalize`'s comment). That's still the right tradeoff, but it
means a macOS-specific failure like this one produces no visible signal
beyond "the run has a red job" and "half the assets are missing," which is
exactly how this went unnoticed since #71. No guard was added for that here;
worth a follow-up (e.g. a step that asserts `latest-mac.yml` exists in the
published release whenever the macOS job's own conclusion was `success`, and
turn on notifications for a failed `Build and publish macOS` job specifically).
