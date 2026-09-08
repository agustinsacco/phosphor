# 09 — Settings

Settings window (Cmd/Ctrl+,), tabbed:

## Appearance

- Theme: Light / Dark / System (live switch across app, Monaco, xterm, Shiki, Mermaid).
- Font sizes: UI scale, chat, editor, terminal. Mono font picker (bundled options).

## Agent (writes pi's `settings.json` — global, with per-workspace override toggle writing `<ws>/.pi/settings.json`)

- Default model + provider (choices from `get_available_models` when a session is live, else parse `models.json` + known providers).
- Default thinking level; `hideThinkingBlock`.
- Steering / follow-up modes ("all" vs "one-at-a-time").
- Compaction: enabled, reserveTokens, keepRecentTokens. Retry: enabled, maxRetries, baseDelayMs.
- Note in UI: changes apply to new sessions (pi reads settings at spawn).

## Accounts

- One row per provider pi can sign into with a subscription (`SUBSCRIPTION_PROVIDERS` in `electron/pi/auth-status.ts`), each showing ready / not ready from `pi auth check --json` and a Sign in button that drives pi's TUI off-screen ([2026-08-26-background-provider-login.md](log/2026-08-26-background-provider-login.md)).
- A signed-in row also shows **which account**, when the provider's credential is a JWT that names one (ChatGPT/Codex today). The check runs with `--credentials` and `electron/pi/auth-identity.ts` reads the email claim out of the token inside the main process; the credential itself is never stored, logged, or sent to the renderer. Providers with an opaque credential (OpenRouter, Anthropic, GitHub) show "Signed in" and nothing more.
- **Sign in again** (switching accounts) finishes on the credential _changing_, not on `pi auth check` reporting ready — the credential already stored answers ready a second after pi prints the URL, and ending the flow kills the pty that is pi's own callback server ([2026-09-08-resign-in-closed-its-own-callback-server.md](log/2026-09-08-resign-in-closed-its-own-callback-server.md)).

- **Claude Code → Accounts** keeps several Claude logins and routes one to each
  new session (`specific`, `ordered`, `round-robin`). An account is held back
  from new sessions while the provider reports it rejected, at its window, or
  **spending overage credits** — the plan is gone but requests still succeed, so
  nothing else would notice. A running session keeps its account either way: the
  credential is fixed at spawn. The context popover names the account a lane is
  spending and shows that account's own plan usage.
- Each account row **opens** onto that account's own usage windows and the live
  sessions spending it (`claude:accountSessions`). A session there can be
  restarted on the same account or moved to another one; both respawn it from
  its session file, which is the only way an account can change
  ([2026-09-06](log/2026-09-06-claude-account-gateway.md)).

## Workspaces

- **New sessions**: whether a chat gets its own branch and worktree, and the
  branch prefix (`WorktreePrefs`).
- **Naming and markers**: auto-naming on/off, the word range and character cap
  for generated titles, the branch-slug cap, and the lane marker mode
  (`LanePrefs`). Every number is clamped in both the renderer and main; see
  [lanes.md](lanes.md#preferences) for what each one reaches.
- Recent workspace list management (remove, reorder, clear).
- Per-workspace: default layout reset.

## Advanced

- Raw file editors (Monaco JSON, schema-validated where schemas exist) for `~/.pi/agent/settings.json` and `models.json`, with a "restart sessions to apply" note. Read-only viewer for discovered extensions/prompts/themes (paths + descriptions) — skills moved to their own page (sidebar → Skills, [2026-09-04-skills-page.md](log/2026-09-04-skills-page.md)). Never render `auth.json` contents.
- pi health: detected pi path + version, min supported, re-check.

## Keybindings

- Reference sheet of all app shortcuts (read-only v1), grouped App / Chat / Editor & terminal.

## Connectors and MCP

- **Connectors**: the curated OAuth catalog (Linear, Notion, Braintrust, Datadog, Supabase, Questrade, Fellow, Slack) — add, sign in, reconnect, remove. Add starts the sign-in itself. Signing in drives the MCP adapter's own `/mcp-auth` command; Phosphor holds no tokens.
- **MCP**: the `mcp.json` resolution chain, custom servers, and raw JSON repair.
- Both are specified in [mcp.md](mcp.md).

Phosphor's own prefs live in electron-store; pi's config stays in pi's files — the two are never mixed.
