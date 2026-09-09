# 09 — Settings

A **modal**, not a second window (`ModalOverlay` in `src/features/settings/SettingsModal.tsx`): it is one more surface in the renderer, so it inherits the theme, the UI scale and the app's lifecycle instead of owning its own. Cmd/Ctrl+, opens it; Cmd/Ctrl+/ opens it on Keybindings. Open/close state lives in its own tiny module (`settingsUiStore.ts`) so the palette and the global shortcuts can open settings without dragging Monaco — pulled in by the raw config editor — into their bundles.

Thirteen tabs (`SettingsTab`), nine of them top-level and four indented under Extensions. Of the four, MCP Connectors is always present; the other three are contributed by a package and render **only while that package is installed**. `packages:list` is re-read on every open, so installing from the Extensions tab makes its tab appear without a restart, and a tab whose package went away out-of-band falls back to Extensions rather than rendering an orphan.

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

## Appearance

- Theme: Light / Dark / System (live switch across app, Monaco, xterm, Shiki, Mermaid).
- **UI scale** (zooms text, icons and spacing together; the same value Cmd/Ctrl+plus/minus/0 nudge) plus separate chat, editor and terminal font sizes, each applying live to open views.
- Mono font: JetBrains Mono is bundled; the other five entries use whatever the OS has installed.
- All of it is Phosphor's own state — `app:setTheme` / `app:setFontPrefs` into electron-store. Nothing here touches pi.

## Agent

Writes pi's own `settings.json`. A **Scope** switch chooses global (`~/.pi/agent`) or an override for the current workspace (`<ws>/.pi/settings.json`), and each scope is read **unmerged**: the editor shows what that file actually contains, because a merged read would silently bake inherited global values into the project file on the next edit. In project scope, an empty field's placeholder names what it inherits (`inherits "…"`) or falls back to `(pi default)`.

- **Default model** and **default provider** are free-text fields, not pickers — pi accepts any id its own config knows, including ones from a custom `models.json` or a local endpoint that no catalogue call would enumerate. The placeholders suggest the shape (`claude-sonnet-4-5`, `anthropic`).
- Default thinking level (off · minimal · low · medium · high · xhigh · max); `hideThinkingBlock`.
- Steering / follow-up delivery ("all" vs "one-at-a-time").
- Compaction: enabled, reserveTokens, keepRecentTokens. Retry: enabled, maxRetries, baseDelayMs.
- **Directives** — what Phosphor appends to every lane's system prompt, global or per project, composed and shown before it is sent. A prompt you cannot read is one you cannot debug, and this one rides every request for the life of the lane.
- If the target file is not valid JSON, editing is **disabled** rather than best-effort: main refuses to write so it cannot clobber a config it failed to parse, and the banner routes to Advanced to repair it by hand.
- Changes apply to **new** sessions; pi reads config at spawn.

## Accounts

The subscription routes are distinct (`SUBSCRIPTION_PROVIDERS` in
`electron/pi/auth-status.ts` is the UI's registry):

| Account        | Route                                                                      | Requirement                  |
| -------------- | -------------------------------------------------------------------------- | ---------------------------- |
| ChatGPT        | pi's native `openai-codex` OAuth; no Codex CLI bridge                      | Plus or Pro                  |
| Claude         | Authenticated Claude Code CLI through `@saccolabs/pi-claude-cli`           | Pro or Max; provider ≥ 0.7.1 |
| GitHub Copilot | pi account login on github.com; Enterprise Server uses pi's terminal login | Copilot subscription         |
| Kimi           | pi's `kimi-for-coding` account login                                       | Kimi For Coding plan         |

Provider limits and billing rules still apply. Native Anthropic OAuth is a
separate route from Claude Code subscription sessions; the Accounts UI warns
that it bills extra usage. xAI, OpenRouter and Radius account sign-ins use a
credit balance rather than an included subscription allowance.

- One row per provider pi can sign into with a subscription (`SUBSCRIPTION_PROVIDERS` in `electron/pi/auth-status.ts`), each showing ready / not ready from `pi auth check --json` and a Sign in button that drives pi's TUI off-screen.
- A signed-in row also shows **which account**, when the provider's credential is a JWT that names one (ChatGPT/Codex today). The check runs with `--credentials` and `electron/pi/auth-identity.ts` reads the email claim out of the token inside the main process; the credential itself is never stored, logged, or sent to the renderer. Providers with an opaque credential (OpenRouter, Anthropic, GitHub) show "Signed in" and nothing more.
- **Sign in again** (switching accounts) finishes on the credential _changing_, not on `pi auth check` reporting ready — the credential already stored answers ready a second after pi prints the URL, and ending the flow kills the pty that is pi's own callback server.

This tab is pi's own `auth`, nothing more. The **Claude Code** provider keeps a separate set of logins, under Extensions → Claude Code below.

## Extensions

pi package management: extensions, skills, prompts and themes. Reads come from pi's settings files and install dirs; every mutation shells out to pi's own package manager (`pi install` / `pi remove` / `pi update`) with the output streamed into the tab, so a failure is legible rather than a silent no-op.

- A **Recommended** catalogue of curated packages (Claude detection decides what it suggests), then Installed lists split by scope — global (all workspaces) and this workspace. Each row shows version, the resources it contributes (`2 extensions · 1 skill`), and a `vX available` chip when the registry says so; the registry lookup is fired separately and never blocks the local listing, since it can be offline or private.
- Add a package by spec (`npm:pkg`, `git:github.com/user/repo`, or an absolute path), with Update all alongside. Packages run with full system access, which the tab says out loud.
- A declared-but-not-yet-installed package is labelled "installs on next session start" — pi never moves an installed package on its own.

Three of these packages contribute their own nested tab, shown only while installed:

### Claude Code (`pi-claude-cli`)

Routes model calls through the Claude Code CLI, billing your Claude Pro/Max plan; its models appear in the picker under the `pi-claude-cli` provider. In order: **Health** (package present, CLI binary found, both versions, update rows), **Accounts**, **Context window** — the auto-compact size, passed as `PI_CLAUDE_CLI_AUTOCOMPACT` at spawn; smaller windows cost less because every request re-reads the whole context — **Prove it end to end** (one tiny print-mode prompt through `pi-claude-cli/claude-haiku-4-5`, exercising the CLI, the login and the extension at once, because "installed" and "working" are different claims), and **When it fails**. See [cli-providers.md](cli-providers.md).

- **Accounts** keeps several Claude logins and routes one to each
  new session (`specific`, `ordered`, `round-robin`). An account is held back
  from new sessions while the provider reports it rejected, at its window, or
  **spending overage credits** — the plan is gone but requests still succeed, so
  nothing else would notice. A running session keeps its account either way: the
  credential is fixed at spawn. The context popover names the account a lane is
  spending and shows that account's own plan usage.
- Each account row **opens** onto that account's own usage windows and the live
  sessions spending it (`claude:accountSessions`). A session there can be
  restarted on the same account or moved to another one; both respawn it from
  its session file, which is the only way an account can change.

### Web access (`pi-web-access`)

Search, fetching and PDF extraction for sessions, writing the package's `web-search.json`. The common search providers get first-class fields; the package supports more, and those stay reachable through the raw file.

### Computer use (`@injaneity/pi-computer-use`)

Read-only information: what the package adds (observe windows, search UI elements, click, type, scroll) and the platform accessibility permissions it needs. No settings of its own.

### MCP Connectors

Also nested under Extensions, since a connector is configuration for the MCP adapter rather than a top-level app concern.

- **Connectors**: the curated OAuth catalog (Linear, Notion, Braintrust, Datadog, Supabase, Questrade, Fellow, Slack) — add, sign in, reconnect, remove. Add starts the sign-in itself. Signing in drives the MCP adapter's own `/mcp-auth` command; Phosphor holds no tokens, it only writes `mcp.json` (or the project's `.mcp.json`).
- **MCP**: the `mcp.json` resolution chain, custom servers, and raw JSON repair.
- Both are specified in [mcp.md](mcp.md).

## Workspaces

- **Naming and markers**: auto-naming on/off, the word range and character cap
  for generated titles, the branch-slug cap, the lane marker mode, and whether
  lanes trail their GitHub PR status (`LanePrefs`). Every number is clamped in
  both the renderer and main, and the branch-length row previews a real slug
  rather than describing the cap; see [lanes.md](lanes.md#preferences) for what
  each one reaches.
- **New sessions**: whether a chat gets its own branch and worktree, and the
  branch prefix (`WorktreePrefs`) — the same switch as the "worktree" checkbox
  in the branch menu.
- **Workspaces**: the recent list, one row per folder, offering exactly two
  things — **Reset layout** (drops every localStorage key mentioning that path,
  so a wedged split or pane selection is recoverable) and **Remove**, which
  forgets the folder and touches nothing on disk. There is no "clear all", and
  **reordering lives in the sidebar**, on each workspace group's kebab
  (Move up / Move down), where you can see the order you are changing.
- **Sandboxes**: the scratch folders behind "No folder", listed separately from
  recents so one folder never grows two different Remove buttons. Each shows its
  item count and last use; deleting moves the folder _and its chats_ to the
  Trash. An empty sandbox is reused, so asking for "no folder" again lands you
  back in the same place until something is written there.

## Optimization

Headroom, the local tool-result compression proxy. Opening the tab probes `/health` and looks for the binary but never starts the proxy and never installs anything — every action here is an explicit button.

- **Status + lifecycle**: installed / not, version, whether the proxy is running and on which loopback port, and whether Phosphor owns it or _adopted_ one already running (Stop is only offered for a proxy we own — an adopted one belongs to whoever started it). Install runs `uv` with the output streamed, and names the manual command for anyone who would rather run it themselves.
- **Compress tool results**: large JSON tool results are restructured losslessly before entering the context, or left untouched — never summarized. Applies to new sessions. Compressing plain search/log output is deliberately off and disabled: that direction is only reversible through Headroom's retrieval store, which needs a Phosphor retrieve tool first.
- **Savings** for the current workspace: tokens saved, lanes with savings, and a per-lane bar chart read from the session files.
- **Advisor**: findings computed from your session files and current configuration — never a model call, never an action taken for you. Each row is tip / warning / serious and can jump to the tab that fixes it.

## Advanced

- **pi health**: the resolved binary path, its version, and the minimum version Phosphor supports, read when the tab opens.
- **Raw file editors** (Monaco JSON) for `~/.pi/agent/settings.json` and `models.json`, with a "restart sessions to apply" note. This is the escape hatch the Agent tab points at when a config file is too broken to edit structurally.
- **Maintenance**: a periodic sweep for worktrees whose branch already landed. It always _measures_ — the row reports "N of M worktrees reclaimable" — and only deletes once "Delete automatically" is on, because a reclaimed lane needs a fresh install to come back. Interval (≥15 min) and a grace period (a merged lane is kept this long after its last use, in case you are still reading it) are both configurable.
- **Local pi resources**: a read-only listing of the loose extensions, prompts and themes pi discovered, up to 8 per column. Packages are the Extensions tab; skills have their own page (sidebar → Skills, [ui-shell.md](ui-shell.md#global-surfaces)). `auth.json` is never read or displayed.

## Keybindings

- Static reference sheet of every app shortcut, in four groups: **App**, **Chat**, **Formatting**, **Editor & terminal**. Read-only — bindings are not yet remappable.
- Spellings follow Claude Code and Claude Desktop where a binding exists there (Esc Esc rewind, ↑ prompt history, ⌃O verbose output), so muscle memory carries over. Terminal copy/paste is the one pair whose _keys_ differ per platform rather than just their rendering: Ctrl+C has to stay SIGINT off macOS, so copy moves to Ctrl+Shift+C there.

## About

App version, an on-demand **Check now** for updates (the sidebar pill only appears once there is something to act on, so this is the only way to ask "am I current?"), pi's version and path, platform/arch, the Electron and Node versions, and the bundled font licenses. A pi newer than the line Phosphor is verified against gets a warning here: newer minors usually work, but protocol additions may not be surfaced yet.

Phosphor's own prefs live in electron-store; pi's config stays in pi's files — the two are never mixed.
