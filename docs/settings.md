# 09 — Settings

A **modal**, not a second window (`ModalOverlay` in
`src/features/settings/SettingsModal.tsx`), so it inherits the theme, the UI
scale and the app's lifecycle. Cmd/Ctrl+, opens it; Cmd/Ctrl+/ opens it on
Keybindings.

Nine top-level tabs and four indented under Extensions. MCP Connectors is always
present; the other three belong to a package and render **only while that
package is installed**. The package list is re-read on every open, so a fresh
install gets its tab without a restart, and a tab whose package vanished falls
back to Extensions.

| Tab              | What it is                                                       | Writes                                                  |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| Appearance       | Theme, UI scale, per-surface font sizes, mono font               | Phosphor prefs (electron-store)                         |
| Agent            | pi's agent defaults, global or per project                       | `~/.pi/agent/settings.json` or `<ws>/.pi/settings.json` |
| Accounts         | Subscription logins pi can drive                                 | nothing — pi owns the credentials                       |
| Extensions       | pi package management                                            | shells out to `pi install` / `remove` / `update`        |
| ↳ Claude Code    | The `pi-claude-cli` provider: health, accounts, context window   | Phosphor prefs + the package's own config               |
| ↳ Web access     | The `pi-web-access` provider: search, fetch, PDF                 | `web-search.json`                                       |
| ↳ Computer use   | Info page for `@injaneity/pi-computer-use`                       | nothing (read-only)                                     |
| ↳ MCP Connectors | Curated OAuth catalog + custom servers                           | `mcp.json`, or the project's `.mcp.json`                |
| Workspaces       | Lane naming/markers, new-session branching, recents, sandboxes   | Phosphor prefs; layout reset clears localStorage        |
| Optimization     | Headroom tool-result compression + the Advisor                   | Phosphor prefs; `headroom:*` lifecycle in main          |
| Advanced         | pi health, raw config editors, maintenance, discovered resources | the pi files it edits; maintenance prefs                |
| Keybindings      | Static reference sheet                                           | nothing                                                 |
| About            | Versions, update check, pi drift warning, font licenses          | nothing                                                 |

Phosphor's prefs live in electron-store. pi's config stays in pi's files. The
two are never mixed.

## Appearance

- Theme: Light / Dark / System. Switches live across the app, Monaco, xterm,
  Shiki and Mermaid.
- **UI scale** zooms text, icons and spacing together (the same value
  Cmd/Ctrl+plus/minus/0 nudge). Separate chat, editor and terminal font sizes,
  each applied live.
- Mono font: JetBrains Mono is bundled; the other entries use whatever the OS
  has.
- All of it is Phosphor's own state. Nothing here touches pi.

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
  maxRetries, baseDelayMs).
- **Directives**: what Phosphor appends to every lane's system prompt, global
  or per project, shown composed before it is sent. A prompt you cannot read is
  one you cannot debug.
- If the target file is not valid JSON, editing is **disabled** rather than
  best-effort, and the banner routes to Advanced to repair it by hand. Main
  never overwrites a config it could not parse.
- Changes apply to **new** sessions. pi reads config at spawn.

## Accounts

The subscription routes are distinct (`SUBSCRIPTION_PROVIDERS` in
`electron/pi/auth-status.ts` is the registry):

| Account        | Route                                                                      | Requirement                  |
| -------------- | -------------------------------------------------------------------------- | ---------------------------- |
| ChatGPT        | pi's native `openai-codex` OAuth; no Codex CLI bridge                      | Plus or Pro                  |
| Claude         | Authenticated Claude Code CLI through `@saccolabs/pi-claude-cli`           | Pro or Max; provider ≥ 0.7.1 |
| GitHub Copilot | pi account login on github.com; Enterprise Server uses pi's terminal login | Copilot subscription         |
| Kimi           | pi's `kimi-for-coding` account login                                       | Kimi For Coding plan         |

Provider limits and billing rules still apply. Native Anthropic OAuth is a
separate route from Claude Code subscription sessions, and the tab says it
bills extra usage. xAI, OpenRouter and Radius sign-ins draw on a credit
balance, not an included allowance.

- One row per provider pi can sign into, showing ready / not ready from
  `pi auth check --json`, and a Sign in button that drives pi's TUI off-screen.
- A signed-in row also shows **which account** when the credential is a JWT
  that names one (ChatGPT/Codex today). The email claim is read inside the
  main process; the credential itself is never stored, logged or sent to the
  renderer. Providers with an opaque credential show "Signed in" and nothing
  more.
- **Sign in again** (switching accounts) finishes when the credential
  _changes_, not when `pi auth check` first reports ready: the old credential
  already answers ready a second after pi prints the URL.

This tab is pi's own `auth`, nothing more. The **Claude Code** provider keeps
its own set of logins under Extensions → Claude Code.

## Extensions

pi package management: extensions, skills, prompts and themes. Reads come from
pi's settings files and install dirs; every mutation shells out to pi's own
package manager (`pi install` / `pi remove` / `pi update`) with the output
streamed into the tab, so a failure is legible rather than a silent no-op.

- A **Recommended** catalogue of curated packages, then Installed lists by
  scope (global, this workspace). Each row shows version, what it contributes
  (`2 extensions · 1 skill`), and a `vX available` chip when the registry says
  so. The registry lookup never blocks the local listing.
- Add a package by spec (`npm:pkg`, `git:github.com/user/repo`, or an absolute
  path), plus Update all. Packages run with full system access, and the tab
  says so.
- A declared-but-not-installed package is labelled "installs on next session
  start". pi installs at session start, never on its own.

Three packages contribute a nested tab, shown only while installed:

### Claude Code (`pi-claude-cli`)

Routes model calls through the Claude Code CLI, billing your Claude Pro/Max
plan; its models appear in the picker under the `pi-claude-cli` provider. In
order: **Health** (package present, CLI binary found, both versions, update
rows), **Accounts**, **Context window** (the auto-compact size, passed as
`PI_CLAUDE_CLI_AUTOCOMPACT` at spawn; smaller windows cost less because every
request re-reads the whole context), **Prove it end to end** (one tiny
print-mode prompt through the CLI, the login and the extension at once, because
"installed" and "working" are different claims), and **When it fails**. See
[cli-providers.md](cli-providers.md).

- **Accounts** keeps several Claude logins and routes one to each new session
  (`specific`, `ordered`, `round-robin`). An account is held back from new
  sessions while the provider reports it rejected, at its window, or
  **spending overage credits**. A running session keeps its account: the
  credential is fixed at spawn. The context popover names the account a lane
  is spending and shows that account's own plan usage.
- Each account row **opens** onto its usage windows and the live sessions
  spending it. A session there can be restarted on the same account or moved
  to another; both respawn it from its session file, which is the only way an
  account can change.

### Web access (`pi-web-access`)

Search, fetching and PDF extraction for sessions, written to the package's
`web-search.json`. Common search providers get first-class fields; the rest
stay reachable through the raw file.

### Computer use (`@injaneity/pi-computer-use`)

Read-only: what the package adds (observe windows, search UI elements, click,
type, scroll) and the accessibility permissions it needs.

### MCP Connectors

Nested under Extensions, since a connector is configuration for the MCP adapter
rather than a top-level app concern.

- **Connectors**: the curated OAuth catalog (Linear, Notion, Braintrust,
  Datadog, Supabase, Questrade, Fellow, Slack). Add, sign in, reconnect,
  remove. Add starts the sign-in itself. Signing in drives the adapter's own
  `/mcp-auth`; Phosphor holds no tokens and only writes `mcp.json` (or the
  project's `.mcp.json`).
- **MCP**: the `mcp.json` resolution chain, custom servers, raw JSON repair.
- Both are specified in [mcp.md](mcp.md).

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
  touches nothing on disk. Reordering lives in the sidebar, on each workspace
  group's kebab, where you can see the order you are changing.
- **Sandboxes**: the scratch folders behind "No folder", listed apart from
  recents. Each shows its item count and last use; deleting moves the folder
  _and its chats_ to the Trash. An empty sandbox is reused.

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
