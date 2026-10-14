# 09 — Settings

A **modal**, not a second window (`ModalOverlay` in
`apps/desktop/src/features/settings/SettingsModal.tsx`), so it inherits the theme, the UI
scale and the app's lifecycle. Cmd/Ctrl+, opens it; Cmd/Ctrl+/ opens it on
Keybindings.

Eleven top-level tabs and five indented under Extensions. MCP Connectors is always
present, since pi's MCP support is built in; the other four belong to packages. Subagents requires an installed
package. The existing provider tabs also show for declared packages so their
health/configuration screens remain reachable during setup. The package list
is re-read on every open, so a fresh install gets its tab without a restart,
and a tab whose package vanished falls back to Extensions.

| Tab              | What it is                                                           | Writes                                                  |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| Appearance       | Theme, UI scale, per-surface font sizes, mono font                   | Phosphor prefs (electron-store)                         |
| Writing          | Spellcheck switch, autocomplete, learned prompts                     | Phosphor prefs; `<userData>/writing/prompts.jsonl`      |
| Agent            | pi's agent defaults, global or per project                           | `~/.pi/agent/settings.json` or `<ws>/.pi/settings.json` |
| Accounts         | Subscription logins pi can drive                                     | pi's provider auth                                      |
| Extensions       | pi package management                                                | shells out to `pi install` / `remove` / `update`        |
| ↳ Claude Code    | The `pi-claude-cli` provider: health, accounts, pi context ownership | Phosphor prefs + the package's own config               |
| ↳ Web access     | The `pi-web-access` provider: search, fetch, PDF                     | `web-search.json`                                       |
| ↳ Subagents      | Delegation guide, profile precedence, configuration ownership        | global Pi settings through the shared raw editor        |
| ↳ Computer use   | Info page for `@injaneity/pi-computer-use`                           | nothing (read-only)                                     |
| ↳ MCP Connectors | pi's built-in MCP: curated OAuth catalog + custom servers            | `~/.pi/agent/mcp.json` or `<ws>/.pi/mcp.json`           |
| Workspaces       | Lane naming/markers, new-session branching, recents, sandboxes       | Phosphor prefs; layout reset clears localStorage        |
| Optimization     | Headroom tool-result compression + the Advisor                       | Phosphor prefs; `headroom:*` lifecycle in main          |
| Voice            | Dictation on/off and which local speech model                        | Phosphor prefs; model files in `<userData>/voice/`      |
| Advanced         | pi health, raw config editors, maintenance, discovered resources     | the pi files it edits; maintenance prefs                |
| Keybindings      | Static reference sheet                                               | nothing                                                 |
| About            | Versions, update check, pi drift warning, font licenses              | nothing                                                 |

Phosphor's prefs live in electron-store. pi's config stays in pi's files. The
two are never mixed.

Below the `md` breakpoint the sidebar becomes a top bar: the search field, then
the tabs as one horizontally scrolling strip. Send feedback stays reachable below
the strip. On wider layouts it is pinned to the bottom of the left column.

## Search

The field at the top of the sidebar takes focus on open; Cmd/Ctrl+F returns to
it from anywhere in settings.

- **Index.** A hand-written list of every row and heading
  (`settingsIndex.ts`), with keybindings taken from the Keybindings tab's own
  tables. Entries carry synonyms ("dark mode" finds Theme). Tabs whose package
  is not installed are left out. `settingsQuery.test.ts` checks the index
  against the tab sources in both directions, so renaming a row without
  updating the index fails CI.
- **Query.** The model picker's grammar (`parseQuery`): words AND together
  across title, section, tab and synonyms, `"quoted phrases"` stay whole,
  `-word` excludes, separators are optional ("autocompaction"). Title prefix
  matches rank first.
- **Results** replace the panel while there is a query, grouped by tab, best
  group first, with matched text emphasised and a keybinding's keys beside it.
  Each sidebar tab shows its match count and dims without any. Up/Down move,
  Enter or a click opens.
- **Opening a result** shows its tab with the query painted over the live
  controls (the find bar's CSS Custom Highlight API, so React's DOM is never
  touched), scrolls to the setting and flashes it. A tab that loads its
  values over IPC is waited on for up to two seconds. Picking a tab in the
  sidebar while searching shows it the same way, without the jump.
- **Escape** clears the query first, and closes settings the second time.
  Reopening settings starts with an empty search.

## Appearance

- Theme: Light / Dark / System. Switches live across the app, Monaco, xterm,
  Shiki and Mermaid.
- **UI scale** zooms text, icons and spacing together (the same value
  Cmd/Ctrl+plus/minus/0 nudge). Separate chat, editor and terminal font sizes,
  each applied live.
- Mono font: JetBrains Mono is bundled; the other entries use whatever the OS
  has.
- All of it is Phosphor's own state. Nothing here touches pi.

## Writing

Spelling and autocomplete in Phosphor's own text fields
(`AppPrefs.writing`, `libs/shared/src/writing.ts`). Neither calls a model and
nothing leaves the machine.

- **Check spelling** (on by default) switches Chromium's spellchecker for the
  app's session (`session.setSpellCheckerEnabled`, applied at launch and on
  change). macOS uses the system spellchecker and its language setting;
  Windows and Linux use Hunspell, whose dictionaries Chromium downloads from
  Google's CDN. Typed text is never sent.
- **The right-click menu** is `features/writing/TextFieldMenu.tsx`: one
  window-level `contextmenu` listener for textareas and text inputs. It stands
  aside when a component already opened its own menu, and skips Monaco and
  xterm, password fields and disabled fields. Suggestions come from the
  preload's synchronous `spellingSuggestions` (`webFrame.isWordMisspelled` /
  `getWordSuggestions`), not from the `context-menu` event's
  `dictionarySuggestions`, which came back empty on macOS with the spelling
  language set to Automatic (electron#24455) while `webFrame` answered.
  _Add to dictionary_ also writes to the OS dictionary on macOS and Windows,
  which other apps share. Cut / Copy / Paste / Select all run in main
  (`writing:edit` → `webContents.paste()` and friends), so a paste still fires
  the field's paste event (images, list continuation).
- **Autocomplete** (off by default) shows ghost text in both composers
  (`ComposerField`). While it is on, every prompt a composer sends is kept in
  `<userData>/writing/prompts.jsonl` (mode 0600, the newest 2,000, no `/`
  or `!` commands, nothing over 2,000 characters). It starts empty: pi's
  session files are not read, because they also hold messages no person typed
  (subagent supervisor prompts, test runs). The model is
  `lib/writing/predictor.ts`: an earlier prompt the current line starts (after
  12 typed characters), else word counts with two words of context, else your
  vocabulary from three typed letters. Only confident guesses show; the
  thresholds and how they were tuned are in that file.
- **Learned prompts** shows the count and clears the file.

## Agent

Writes pi's own `settings.json`. A **Scope** switch picks global
(`~/.pi/agent`) or the current workspace (`<ws>/.pi/settings.json`). Each scope
is read **unmerged**: the editor shows what that file actually contains, so a
project edit never bakes inherited global values into the project file. In
project scope, an empty field's placeholder names what it inherits.

- **Default model** and **default provider** are free text, not pickers: pi
  accepts any id its config knows, including a custom `models.json` or a local
  endpoint no catalogue would list.
- Default thinking level (off · minimal · low · medium · high · xhigh · max);
  `hideThinkingBlock`.
- Steering / follow-up delivery ("all" vs "one-at-a-time").
- Compaction (enabled, reserveTokens, keepRecentTokens) and retry (enabled,
  maxRetries, baseDelayMs). Compaction applies to every provider, including
  Claude Code; switching models does not override the user's choice.
- **Context budget**: a shared target for interactive sessions on every
  provider, Claude Code included (default 200k; 400k; model maximum; or
  custom, 100k–1M). Bare numbers are thousands: `500` means 500k, previewed
  beside the field. This unscoped Phosphor pref stays editable even when pi's
  settings file is broken. pi uses the capped window between tool cycles, including live
  sessions. Smaller windows retain pi's native limit. See
  [One context budget](cli-providers.md#one-context-budget).
- **Directives**: what Phosphor appends to every lane's system prompt, global
  or per project, shown composed before it is sent. A prompt you cannot read is
  one you cannot debug.
- If the target file is not valid JSON, editing is **disabled** rather than
  best-effort, and the banner routes to Advanced to repair it by hand. Main
  never overwrites a config it could not parse.
- pi settings apply to **new** sessions. The context budget is the live-session
  exception described above.

## Accounts

The subscription routes are distinct (`SUBSCRIPTION_PROVIDERS` in
`libs/session-runtime/src/pi/provider-auth.ts` is the registry, shared with the
Host's `phosphor providers`):

| Account        | Route                                                                      | Requirement                   |
| -------------- | -------------------------------------------------------------------------- | ----------------------------- |
| ChatGPT        | pi's native `openai-codex` OAuth; no Codex CLI bridge                      | Plus or Pro                   |
| Claude         | Authenticated Claude Code CLI through `@saccolabs/pi-claude-cli`           | Pro or Max; provider ≥ 0.10.0 |
| GitHub Copilot | pi account login on github.com; Enterprise Server uses pi's terminal login | Copilot subscription          |
| Kimi           | pi's `kimi-for-coding` account login                                       | Kimi For Coding plan          |

Provider limits and billing rules still apply. Native Anthropic OAuth is a
separate route from Claude Code subscription sessions, and the tab says it
bills extra usage. xAI, OpenRouter and Radius sign-ins draw on a credit
balance, not an included allowance.

- One row per provider pi can sign into, showing ready / not ready from
  `pi auth check --json`, and a Sign in button that drives pi's TUI off-screen.
- That off-screen pi runs in an empty folder under userData (`pi-sign-in`)
  with `--no-approve --no-extensions`, because any startup dialog swallows the
  typed `/login`. Home is not neutral: pi treats its cwd as a project, and
  project config there can open a startup dialog. The login
  terminal uses the same folder and `--no-approve` but keeps extensions.
- A sign-in that stops at a screen it does not recognise logs that screen to
  the debug log (`[login]`), and an ended flow (signed in, cancelled or
  failed) frees the row and re-reads auth.
- A signed-in row also shows **which account** when the credential is a JWT
  that names one (ChatGPT/Codex today). The email claim is read inside the
  main process; the credential itself is never stored, logged or sent to the
  renderer. Providers with an opaque credential show "Signed in" and nothing
  more.
- **Sign in again** (switching accounts) finishes when the credential
  _changes_, not when `pi auth check` first reports ready: the old credential
  already answers ready a second after pi prints the URL.

This tab is pi's own `auth`. The **Claude
Code** provider keeps its own set of logins under Extensions → Claude Code.

### Phosphor account

Optional GitHub sign-in lives in the sidebar footer, not in this tab.
It lets you add and manage Hosts on the Machines page
([remote-access.md](remote-access.md)). Local work never needs it.
Launch reads the plain profile. A signed-out launch makes no control request
and never reads the keychain. An encrypted credential is read only when its
session file exists and a signed-in request needs a token.

- **GitHub through Supabase Auth**, with no email. Main runs PKCE: the system
  browser opens Supabase's authorize page, and Supabase sends it back to a
  one-shot server on `127.0.0.1`, at a port the OS picks and a random path only
  that sign-in knows. Main exchanges the code with its verifier
  (`apps/desktop/electron/account/`).
- **The renderer sees who, never a token.** `account:get` and `account:changed`
  carry the GitHub login, name, email, an optional main-fetched avatar data URL and whether
  the sign-in is remembered.
  GitHub's own token is dropped on arrival.
- **Remembered with the OS keychain** (`safeStorage`): the refresh token is
  encrypted in `<userData>/account/session.bin`, beside a plain `profile.json`,
  both readable by the user alone. On Linux desktops Chromium does not recognise,
  Phosphor checks the session bus before startup and selects Secret Service or
  KWallet when present, unless a password store was explicitly chosen. When
  Chromium selects no keyring (`basic_text`), the refresh token is saved
  unencrypted in `session.txt` (0600 in the 0700 account directory). If a
  keyring is selected but unavailable, or the backend cannot be identified, the
  sign-in lasts until Phosphor quits. The account view reports: "Saved in a file only your user
  can read, because no keyring is running." Unsafe files are refused and removed.
  A successful refresh with a keyring saves it encrypted and removes the plain
  file. Sign-out removes both token files, the profile and the cached avatar.
- **Sign-out always works here** and tells Supabase when it can. A sign-out or
  cancel wins over anything still in flight: a session that arrives late is
  revoked, not kept. The screen shows signed out at once, while the revocation
  is still on its way, so quitting waits for requests to Supabase already
  started (up to 10 s, then quits anyway and logs it).
- **Avatar**: main fetches only HTTPS GitHub avatars from
  `avatars.githubusercontent.com`, without credentials or redirects, with a
  256 KiB cap and a 10 s timeout. Raster image content types only. The
  owner-only cache sits beside `profile.json` and is tied to the account id
  and avatar address. It shows a face at once; each sign-in and launch still
  fetches once, because GitHub keeps the address when the picture changes.
  The renderer loads a data URL under its existing CSP. Failure uses initials
  on a deterministic theme colour.
- **Every window shows what main pushes** on `account:changed`. An action's own
  reply is not applied, because it can be older than a push from another window.
- **Unpackaged builds only:** `PHOSPHOR_SUPABASE_URL` and
  `PHOSPHOR_SUPABASE_KEY` point at a local stack, and
  `PHOSPHOR_ACCOUNT_NO_KEYCHAIN=1` keeps e2e runs off the keychain. A packaged
  build always signs in to the hosted project.

Phosphor's main-process log is `~/Library/Logs/Phosphor/phosphor.log` on macOS
and `~/.config/Phosphor/logs/phosphor.log` on Linux, rotating at 5 MB. Account
sign-in start, browser opening, callback, finish, failure class, cancellation,
refresh and sign-out use `[account]`. The log records the user id and GitHub
login, never an email, token, callback code or exception message. `[control]`
records control API calls; `[machines]` records Realtime and fetch observations.
See [Tracing a machine](remote-access.md#tracing-a-machine) for correlation and
liveness rules. An E2E profile writes only to its own log folder.

## Extensions

pi package management: extensions, skills, prompts and themes. Reads come from
pi's settings files and install dirs; every mutation shells out to pi's own
package manager (`pi install` / `pi remove` / `pi update`) with the output
streamed into the tab, so a failure is legible rather than a silent no-op.

- A **Recommended** catalogue of curated packages, then Installed lists by
  scope (global, this workspace). Each row shows version, a `vX available`
  chip when the registry says so, and what the package contributes, by name:
  its skills (with a "View in Skills" jump), prompt commands, extensions and
  themes. The registry lookup never blocks the local listing.
- Contents come from the install dir (`libs/session-runtime/src/pi/package-resources.ts`).
  A `pi` manifest lists folders and globs, not resources, so each entry is
  expanded the way pi expands it (`"skills": ["./skills"]` is every bundle in
  that folder) and `!pattern` exclusions are applied. A kind the manifest
  omits is empty even if the folder exists, because pi will not load it.
  Settings-level filters (the object form) are not applied; the row says
  "filtered" instead.
- Add a package by spec (`npm:pkg`, `git:github.com/user/repo`, or an absolute
  path), plus Update all. Packages run with full system access, and the tab
  says so.
- A declared-but-not-installed package is labelled "installs on next session
  start". pi installs at session start, never on its own.

Four packages contribute a nested tab. Package discovery uses the active
workspace, including project packages. The Subagents guide requires an installed
package; the other tabs preserve their declared-package setup behavior:

### Claude Code (`pi-claude-cli`)

Routes model calls through the Claude Code CLI, billing your Claude Pro/Max
plan; its models appear in the picker under the `pi-claude-cli` provider. In
order: **Health** (package present, CLI binary found, both versions, update
rows), **Accounts**, pi context ownership guidance (Claude sessions follow
the Agent tab's compaction settings and context budget), **Prove it end to end** (one tiny
print-mode prompt through the CLI, the login and the extension at once, because
"installed" and "working" are different claims), and **When it fails**. See
[cli-providers.md](cli-providers.md).

- **Accounts** keeps several Claude logins and routes one to each new session
  (`specific`, `ordered`, `round-robin`). An account is held back from new
  sessions while the provider reports it rejected, at its window, or
  **spending overage credits**. A running session keeps its account: the
  credential is fixed at spawn. The context popover names the account a lane
  is spending and shows that account's own plan usage.
- Each account row **opens** onto its usage windows (read under that
  account's own CLI config dir, so they cannot show another account's
  numbers) and the live sessions spending it. A session there can be restarted on the same account or moved
  to another; both respawn it from its session file, which is the only way an
  account can change.

### Web access (`pi-web-access`)

Search, fetching and PDF extraction for sessions, written to the package's
`web-search.json`. Common search providers get first-class fields; the rest
stay reachable through the raw file.

### Subagents (`pi-subagents`)

A searchable guide to parent/child responsibilities, foreground and background
work, source precedence, context, permissions and results. Configuration stays
with its owner: Pi settings for defaults and profile overrides, Markdown for
agents, extension `config.json` for runtime limits, and Phosphor's Agent tab
for delegation directives. The global settings button reuses the raw editor;
it does not rewrite profiles or extension runtime configuration. The tab does
not launch work and is not proof that a particular session loaded the package.

### Computer use (`@injaneity/pi-computer-use`)

Read-only: what the package adds (observe windows, search UI elements, click,
type, scroll) and the accessibility permissions it needs.

### MCP Connectors

Nested under Extensions, since a connector is configuration for pi rather
than a top-level app concern.

- **Connected**: every server pi resolves from its global and project
  `mcp.json`, with its state from `pi mcp list` (**Check again**), Sign in,
  enabled, exposure, Edit and Remove. Signing in runs `pi mcp login`; Phosphor
  holds no tokens and only writes `mcp.json`.
- **Add a connector**: the curated OAuth catalog (Linear, Notion, Braintrust,
  Datadog, Supabase, Questrade, Fellow, Slack). Add writes the entry and
  starts the sign-in itself.
- **Advanced**: both config files and the raw JSON editor, for repair.
- While pi-mcp-adapter or its config is still present, the tab shows only the
  migration card instead.
- All of it is specified in [mcp.md](mcp.md).

## Workspaces

- **Naming and markers**: auto-naming on/off, the word range and character cap
  for generated titles, the branch-slug cap, the lane marker mode, and whether
  lanes show their PR status (`LanePrefs`). Every number is clamped in both
  the renderer and main, and the branch-length row previews a real slug. See
  [lanes.md](lanes.md#preferences).
- **New sessions**: whether a chat gets its own branch and worktree, and the
  branch prefix (`WorktreePrefs`). Same switch as the "worktree" checkbox in
  the branch menu.
- **Workspaces**: the recent list, one row per folder, offering exactly two
  things: **Reset layout** (drops every localStorage key for that path, so a
  wedged split is recoverable) and **Remove**, which forgets the folder and
  touches nothing on disk. Remove is the same action as the sidebar kebab's
  **Remove from sidebar**: it closes the project's idle chats and lanes (a
  live chat would otherwise hold its group in the sidebar; transcripts stay
  and reopen from disk), refuses while one of them is mid-turn, steps the home
  screen off the folder, and forgets the launch-resume target if it was inside
  it, so the next launch does not reopen and re-add it. Reordering lives in
  the sidebar, on each workspace group's kebab, where you can see the order
  you are changing.
- **Sandboxes**: the scratch folders behind "No folder", listed apart from
  recents. Each is minted under a random `adjective-noun` name and shows its
  item count and last use. **Rename** changes the folder on disk and moves its
  chats with it — a sandbox IS its path, so the rename re-points recents, the
  launch-resume pair, and every pin, marker and unseen badge on its sessions.
  "Its chats" means the whole subtree: a sandbox that is a git repo has lanes,
  each its own cwd with its own pair of transcript directories, and moving only
  the root's pair orphaned every lane chat. Running chats in the sandbox are
  **closed** as part of the rename, and the prompt says how many before you
  commit. They have to be — pi cannot keep working in a folder that has moved,
  and since nothing reclaims an idle session's process, refusing instead meant
  a sandbox you had actually used could not be renamed for the rest of the
  launch. Deleting moves the folder _and its chats_ to the Trash, and is still
  refused while anything is running anywhere inside it. An empty sandbox is
  reused.
  A rename also **rewrites the cwd stored inside each session file**, because
  pi refuses to resume a session whose stored cwd is gone — it prints
  `Stored session working directory does not exist` and exits 1 before the RPC
  loop starts, which reads as a chat that simply will not open. Correcting the
  cwd on the scan is not enough: that fixes what Phosphor passes pi, not what
  pi reads back out of the file. See
  [ui-shell.md](ui-shell.md#left-sidebar-claude-desktop-style).

## Optimization

Headroom, the local tool-result compression proxy. Opening the tab probes
`/health` and looks for the binary but never starts the proxy and never
installs anything. Every action is a button.

- **Status + lifecycle**: installed or not, version, whether the proxy runs and
  on which loopback port, and whether Phosphor owns it or _adopted_ one already
  running (Stop is only offered for a proxy we own). Install runs `uv` with
  streamed output and names the manual command.
- **Compress tool results**: large JSON tool results are restructured
  losslessly before entering context, or left alone. Never summarized. Applies
  to new sessions. Compressing plain search/log output is deliberately off:
  that direction is only reversible through Headroom's retrieval store, which
  needs a Phosphor retrieve tool first.
- **Savings** for the current workspace: tokens saved, lanes with savings, a
  per-lane bar chart read from the session files.
- **Advisor**: findings computed from your session files and configuration.
  Never a model call, never an action taken for you. Each row is tip / warning
  / serious and jumps to the tab that fixes it.

## Voice

Voice input on or off, and the model (Moonshine Tiny or Base, English only).
Turning it on downloads the model and turning it off deletes it; the tab
shows progress, readiness or the failure with Retry. Behaviour, download and
privacy rules are in [voice.md](voice.md).

## Advanced

- **pi health**: resolved binary path, version, and the minimum version
  Phosphor supports.
- **Raw file editors** (Monaco JSON) for `~/.pi/agent/settings.json` and
  `models.json`, with a "restart sessions to apply" note. The escape hatch the
  Agent tab points at when a file is too broken to edit structurally.
- **Maintenance**: a periodic sweep for worktrees whose branch already landed.
  It always _measures_ ("N of M worktrees reclaimable") and only deletes once
  "Delete automatically" is on. Interval (≥15 min) and a grace period (a merged
  lane is kept this long after its last use) are configurable. See
  [lanes.md](lanes.md#reclaiming-lanes-automatically).
- **Local pi resources**: a read-only listing of the loose extensions, prompts
  and themes pi discovered. Packages are the Extensions tab; skills have their
  own page ([ui-shell.md](ui-shell.md#global-surfaces)). `auth.json` is never
  read or displayed.

## Keybindings

A static sheet of every shortcut in four groups: **App**, **Chat**,
**Formatting**, **Editor & terminal**. Not remappable yet. Spellings follow
Claude Code and Claude Desktop where a binding exists there (Esc Esc rewind, ↑
prompt history, ⌃O verbose output), so muscle memory carries over. Terminal
copy/paste differs per platform because Ctrl+C must stay SIGINT off macOS.

## About

App version, an on-demand **Check now** for updates (the sidebar pill only
appears once there is something to act on, so this is the way to ask "am I
current?"), pi's version and path, platform/arch, Electron and Node versions,
and the bundled font licenses. A pi newer than the line Phosphor is verified
against gets a warning: newer minors usually work, but protocol additions may
not be surfaced yet.
