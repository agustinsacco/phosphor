# Appearance-aware startup screen

The app previously revealed the shell as soon as a workspace path was known,
before the restored transcript and sidebar scan finished. The native window
also always painted dark, regardless of the saved appearance.

Startup now has one full-window, token-themed Phosphor screen: the shared
Phosphor Beacon and current stage (reduced-motion aware). Main resolves
the window background from preferences and passes appearance to preload, which
applies it before the document paints. The renderer shows the screen during
font/preference loading, then through health checks and restoration. Sidebar
reports its existing initial-readiness signal; the shell stays mounted but
hidden/inert until both sidebar and restoration settle. Global shortcuts are
disabled during startup. No artificial delay or new model/network dependency.

The gate is launch-only: subsequent session opens and scans retain local
loading states. Missing pi still opens setup. Failed startup operations expose
retry; failed restoration can be skipped. A failed sidebar preference read
falls back to expanded groups rather than leaving startup blocked.

Coverage: preload tests for explicit/system appearance and pre-parser timing;
Electron tests hold restore, transcript and scan IPC boundaries to verify the
screen/handoff, explicit light/dark palettes, system appearance before async
prefs, reduced motion, and error recovery. Dark and light screenshots are
captured by the startup e2e tests.

## Shared loading identity (follow-up)

Requested as part of #231; that PR merged while the extension was being
validated, so the Beacon ships as the isolated follow-up #233.

The lane indicator's 13px spark was too easy to miss next to emoji and state
dots. `PhosphorLoader` replaces it across startup and all agent-activity
surfaces with a persistent core and orbiting signal. Starting/working lanes
also receive a static inset rail and readable activity chip, independent of
selection. The old spark component and CSS are removed. The design-system
contract lives in [the style guide](../style-guide.md#loading-identity--phosphor-beacon).

New Electron coverage drives pending → working → disk-backed → settled states,
checks background lanes, real animation and reduced motion in both appearances,
and verifies that checkbox hover and narrow sidebar layouts remain stable.
Component tests cover decorative/standalone accessibility, scale and paused
error states. No provider/RPC state semantics changed.
