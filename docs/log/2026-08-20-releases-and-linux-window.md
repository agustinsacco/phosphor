# 2026-08-20 — Releases that actually ship, and a window that fits Linux

**Every continuous release since v0.1.39 was broken, and the in-app updater
could never have fired.** Each published release contained exactly one asset
(the x64 AppImage) and no `latest-*.yml`, so `checkManually()` polled a URL
that 404s, hit its `!response.ok` branch, and applied an `error` event — which
`reduceUpdate` deliberately collapses to `idle`. A silent no-op, indefinitely.

Three independent causes, each masking the next:

- **Linux** died building the `.deb`: electron-builder needs `author.email`
  for the maintainer field, and `package.json` had the bare string `"Phosphor"`.
  Fixing that surfaced a second hard error, `Please specify project homepage`,
  invisible until the first was fixed. Both are now set, plus `repository`.
- **macOS** died in code signing with `⨯ <projectDir> not a file`. A missing
  GitHub secret arrives as an **empty string**, and electron-builder reads an
  empty `CSC_LINK` as a certificate _path_, resolving it to the project dir.
  Both release workflows now unset the signing vars when `CSC_LINK` is empty
  and set `CSC_IDENTITY_AUTO_DISCOVERY=false`. `release.yml` needed
  `shell: bash` for this, since its matrix includes windows-latest.
- **`finalize` gated on `build` succeeding**, which contradicted the comment
  above `fail-fast: false` ("a half-published release is still installable on
  the platform that built"). One red platform stranded the whole release: no
  `install.sh`, no manifest, never flipped out of draft. Now `!cancelled()`.

Verified by building the `.deb` locally end to end: correct `Maintainer` and
`Homepage` control fields, and `latest-linux.yml` — the file whose absence
caused all of this — is generated again. The macOS path is reasoned, not
verified; no mac signing environment was reachable.

**Install was documented against a repo that does not exist.** The README and
`install.sh` both defaulted to `Phosphor-app/Phosphor`, which 404s, while
`updater.ts` correctly used `agustinsacco/Phosphor`. The app could find its
updates; a new user could not find the app. Also: the continuous workflow
never published `checksums.txt`, so every `curl | sh` install printed
"continuing without verification". `finalize` now computes and uploads it.

**Windows would have polled the wrong manifest.** `checkManually()` chose
between `latest-mac.yml` and `latest-linux.yml`, so win32 read the Linux
manifest. electron-builder names that one plain `latest.yml`.

**The window was macOS-shaped on every platform.** `titleBarStyle` was
`hiddenInset` on macOS and `default` elsewhere, but the sidebar and chat
header unconditionally reserve a 44px `h-11` drag strip for the traffic
lights. On Linux that strip sat _below_ a native title bar and a menu bar —
about a third of the window was chrome, with an empty band under it. Now
frameless everywhere: Windows/Linux get the Window Controls Overlay
(`@platform win32,linux`) at the same 44px, `autoHideMenuBar`, and a new
`.titlebar-inset-end` so the chat header's buttons clear the OS-drawn
controls. `electron/window-chrome.ts` re-applies the overlay colors on theme
change, since that strip is painted by the OS and does not inherit the page
theme. Verified by screenshot on Pop!_OS; maximize is still reachable via the
window manager, though the Linux overlay draws only minimize and close.

**Key hints lied to every non-Mac user.** 34 hardcoded `⌘`/`⌥`/`⇧` glyphs and
no platform detection anywhere in the renderer — the composer told Linux users
to press `⌥Enter` for a queued follow-up. The handlers were always correct
(`event.metaKey || event.ctrlKey`), so only the labels were wrong. `platform`
is now a synchronous field on `PhosphorApi` (labels render on first paint, so an
async `invoke` would flash the wrong modifier), and `src/lib/shortcuts.ts`
formats per platform: glyphs run together on macOS, `Ctrl+Shift+E` elsewhere.
The `⌥` in `sessionSubtitle.ts` is a worktree marker, not a key, and was left
alone.
