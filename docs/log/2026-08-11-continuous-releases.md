# 2026-08-11 — Continuous releases and in-app auto-update

Every green CI run on `main` now publishes an installable release, and the
installed app offers "Restart to update" from the sidebar footer.

**Pipeline** (`.github/workflows/release-continuous.yml`). Triggered by
`workflow_run` on the CI workflow filtered to `main` + `success`, so a red build
can never publish and the test matrix is not duplicated. Version is computed as
`0.1.<commit count>` and injected via `--config.extraMetadata.version`, so
nothing commits a version bump back to `main` (which would re-trigger CI) and
`app.getVersion()` picks it up with no app-code change.

Uses electron-builder's own GitHub publisher rather than a hand-rolled upload:
that is what generates `latest-mac.yml` / `latest-linux.yml` — the version+sha512
manifests `electron-updater` polls — plus the `.blockmap` files that make updates
differential instead of a full ~100MB re-download. Both mac arches build in ONE
invocation; splitting them across jobs makes the second upload clobber the
first's `latest-mac.yml` and silently break auto-update. The existing tag-driven
`release.yml` survives as the deliberate/Windows path.

A `Skip-Release: true` git trailer skips publishing; an existing tag skips
rather than fails, so re-runs and `workflow_dispatch` replays are safe. The
trailer replaced a prose marker after two prose-matching attempts each
suppressed their OWN release by merely mentioning the marker (v0.1.37 lost to a
whole-message match, v0.1.38 to a subject-only match). A trailer cannot be
tripped by talking about it — the whole point. Unit tested against both real
commit messages.

**Updater** (`electron/updates/`). `update-state.ts` is a pure reducer so every
transition is unit-tested without Electron or a network. `updater.ts` owns the
I/O, hard-gated on `app.isPackaged` — dev, the browser harness and the e2e suite
must never poll GitHub, and an e2e test asserts exactly that (verified to fail
when the gate is removed).

Two paths, chosen at startup from a build-time flag rather than by waiting for a
failure: full auto-update where the platform can install (signed macOS, Linux
AppImage), and `manual-download` where it cannot — unsigned macOS, because
Squirrel.Mac validates the code signature and refuses, and deb, where the package
manager owns the files. CI stamps `phosphorSigned` only when the signing secrets
exist, so adding an Apple cert upgrades macOS to full restart-to-update with zero
code changes. The manual path reads `latest-*.yml` straight off
`releases/latest/download/` (a static asset — no API, no rate limit).

Downloading is automatic; **installing is always a user click**. Errors collapse
to idle and are logged only — a failed update check is not the user's problem.

**UI.** `UpdatePill` sits above Settings in the sidebar footer. Hidden while
idle/checking/unsupported, informational while downloading (with percentage),
and only clickable once there is something to do.
