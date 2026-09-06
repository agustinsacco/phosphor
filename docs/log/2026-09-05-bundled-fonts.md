# Bundled typography

Inter and JetBrains Mono now ship as upstream variable normal/italic faces
(1,349,192 bytes), with pinned provenance and licenses in Settings → About.

`src/lib/fonts.ts` registers settled fonts before React/Monaco/xterm mount. After
1.5 seconds, failed/late faces keep system fallbacks for that launch: no delayed
swap under cached cursor metrics. Saved font preferences and sizes are unchanged.
Tests cover success, failure, late completion and actual custom glyphs offline.
