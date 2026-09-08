# 2026-08-27 — macOS could detect an update but never install one

Follow-up to [the ad-hoc signing fix](2026-08-24-mac-adhoc-signing.md), which
closed with "macOS self-update remains off" and a note that turning it on needs
an Apple Developer account. It still does — for the `electron-updater` path.
This change gives macOS a one-click update without one.

## Where it stood

Linux worked and macOS did not, for a reason that was entirely deliberate and
entirely invisible to the user.

The release workflow hardcodes `SIGNED=true` for Linux, so `phosphorSigned=true`
lands in the packaged `package.json`, `canSelfInstall()` sees `$APPIMAGE`, and
`AppImageUpdater.doInstall` overwrites the AppImage in place and respawns it.
One click, restart included. Confirmed by reading the shipped module rather
than trusting the comment: `install.sh` names the AppImage `Phosphor` with no
version in it, which is exactly the case where electron-updater overwrites
rather than writing a sibling.

macOS never entered that path. `gh api .../actions/secrets` returns
`total_count: 0` — there is no `MAC_CERT_P12` — so `SIGNED=false`, and
`"phosphorSigned": false` sits inside the shipped `/Applications/Phosphor.app` asar
(verified against v0.1.115). `canSelfInstall()` returned false, `checkManually()`
ran, and the pill's only action was `shell.openExternal` to the releases page.
Everything after that was the user: download, mount, drag, relaunch.

**Flipping the flag would have made it worse.** `MacUpdater` delegates to
Electron's `autoUpdater`, i.e. Squirrel.Mac, which validates the downloaded
bundle against the RUNNING app's designated requirement. An ad-hoc signature's
requirement is a per-build `cdhash`, so it can never match. That trades "opens
a browser" for "errors silently".

## The fix

A third update path, `mac-self`, in `electron/updates/mac-installer.ts`. It
does what `install.sh` does, from the main process: fetch the arch-matched zip
named in `latest-mac.yml`, verify its sha512, expand it with `ditto`, verify
the resulting bundle, swap it in, relaunch. Detection, download and staging all
happen in the background, so the pill reaches "Restart to update" exactly as it
does on Linux; the restart is still only ever a user click.

`canSelfInstall()` became `resolveUpdatePath()` returning
`updater | mac-self | manual`. The switch is unchanged in spirit: if the five
signing secrets ever get set, macOS returns to `updater` and this module
becomes deletable.

Design decisions worth keeping:

- **Staging lives beside the installed bundle, not in `/tmp`.** That makes the
  swap two atomic same-volume renames instead of a multi-second copy that can
  half-fail. If the second rename throws, the first is undone and the running
  app is untouched — the case worth designing for, since the alternative is a
  user with no Phosphor at all.
- **`ditto -x -k`, not `unzip`.** ditto preserves the symlinks, permissions and
  xattrs the bundle's signature is computed over.
- **Verify before the swap, not after.** `codesign --verify --deep --strict`
  plus a `CFBundleShortVersionString` match. A bundle that fails never reaches
  `/Applications`, so the worst case is a failed update rather than a broken
  app.
- **The relauncher polls for our pid.** A fixed sleep is not good enough:
  `before-quit` SIGTERMs every pi child, kills the PTYs and closes the watchers
  before quitting, and main.ts holds a single-instance lock. A replacement that
  starts too early takes the `second-instance` path, focuses the window that is
  already dying, and exits — leaving the user with nothing. Bounded at 60s.
- **A failed self-install degrades to `manual-download`, not to silence.** The
  new `install-failed` event carries the release URL, so the fallback is
  exactly today's behaviour rather than an update that vanished.

## Two bugs found on the way

**Manual checks polled the wrong manifest on arm64 Linux.** electron-builder
names the manifest per platform AND per non-primary arch: an arm64 build
publishes `latest-linux-arm64.yml` alongside the x64 `latest-linux.yml`, and
v0.1.115 has both. `checkManually()` asked for `latest-linux.yml` on every
Linux arch. It worked only because every arch of a release carries the same
version number — a coincidence, not a design.

**Nothing in the app ever called `updates:check`.** The channel and its handler
have existed since the updater landed, with no caller on any surface. The pill
is deliberately invisible until there is something to act on, so there was no
way to ask "am I current?". Settings → About now has a **Check now** row.

## The orphan sweep

Staging beside the bundle means a crash or force-quit between "extracted" and
"swapped" strands ~600MB in `/Applications`. `sweepOrphans` runs once at
startup — the only moment we know no swap is in flight — and removes entries
matching exactly `.phosphor-update-<pid>-<stamp>` or `.phosphor-old-<pid>-<stamp>.app`
in the bundle's own parent.

The match is a full-string regex, not a prefix test, and that is the point: this
is `rm -rf` next to a user's `/Applications`, and `.phosphor-old-notes` must
survive it. There is a test that says so.

## Verification

The previous two write-ups both end with "only a real packaged build catches
this", so the IO was exercised for real rather than reasoned about.

- **Staging, end to end against the live release.** Parsed the published
  `latest-mac.yml`, picked `Phosphor-0.1.116-arm64-mac.zip` for `process.arch`,
  downloaded all 171MB, verified the sha512, expanded with `ditto`, and passed
  `codesign --verify --deep --strict` and the version check — into a throwaway
  directory, so nothing near `/Applications` moved.
- **The relaunch wait.** Ran `spawnRelauncher` against a stand-in process that
  exits after 3s. The backup was still present at 1.5s (victim alive) and gone
  at 4.5s (victim exited), which is the single-instance hazard covered.
- **The swap, both directions,** as unit tests against a real filesystem: the
  success case, and a rollback that restores the original when the second
  rename fails. A mocked rename would pass a test and lose a user their app.

Not verified: the swap against a real `/Applications/Phosphor.app`, which needs a
release newer than the running build and destroys the install if it is wrong.
The rollback path and the manual-download fallback exist for exactly that risk.

## What this does not change

- **Nothing user-facing resets.** Every pref, session and token lives outside
  the bundle; the full list is in
  [reference/updates.md](../updates.md#what-an-update-does-not-touch).
- **macOS may still re-prompt for TCC permissions** after an update, because
  ad-hoc signing gives a new `cdhash` per build. `install.sh` already replaces
  the bundle the same way, so this is not new.
- **An in-flight turn is still lost on restart**, since pi writes a session file
  only when a turn ends. True before this change too, but a one-click restart
  makes it easier to do mid-stream. Left as-is deliberately.
- **`spctl` still says `rejected`.** Ad-hoc means signed-by-nobody, and a real
  Developer ID remains strictly better than all of this.
