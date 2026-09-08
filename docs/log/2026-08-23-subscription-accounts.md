# Signing into subscription providers without leaving the app

pi can bill three providers to a consumer subscription instead of an API key —
ChatGPT (Codex), Claude Pro/Max, and GitHub Copilot — and until now the only
way to use any of them from Phosphor was to quit, run `pi` in a terminal, and
type `/login`. Settings → **Accounts** brings that in-app.

## Why it hosts pi's TUI instead of doing OAuth itself

The obvious design — provider cards with a real "Sign in" button that opens a
browser — was rejected after looking for a seam and not finding one:

- pi's RPC protocol has **no auth command**. The full command union is
  prompt/abort/fork/compact/get\_\* and friends; nothing touches credentials.
- There is no `pi login` subcommand either. `pi auth` offers only
  `print-api-key`, `print-bearer-token` and `check`.
- `@earendil-works/pi-ai` used to export a clean OAuth registry
  (`getOAuthProviders()`, `login(callbacks)`) at `dist/utils/oauth/index.js`.
  In 0.84.2 — the version pi actually ships — the public `./oauth` subpath is
  **types-only**, and the runtime has moved.

That last point is the whole argument. The API did not just become private;
it relocated between two minor versions. Importing it by deep path would have
made every pi upgrade a coin flip, in a repo whose first architectural rule is
that Phosphor does not reach into pi's internals.

So the tab spawns pi in a PTY, sends `/login`, and lets the user complete
pi's own flow. It is one extra provider selection for the user and zero
coupling for us — and it will keep working for providers pi has not shipped
yet.

## What is actually new

- `pi:subscriptionAuth` shells out to `pi auth check` per provider, with
  `--json --no-refresh`. That command is supported, documented and stable,
  and it exits 0 even for a signed-out provider — so a **throw** from
  it means the spawn failed, never "signed out". Those two cases render
  differently ("Unknown" vs "Not signed in") because conflating them is how a
  broken pi install starts looking like a logged-out account.
- `pi:loginTerminal` spawns `pi --no-session` in a PTY. `--no-session` keeps
  the throwaway process out of the sidebar.
- `PtyManager.create` grew an optional `command` override. Terminals are
  unaffected; the only other caller is this one.
- The provider list is **hand-curated** in `electron/pi/auth-status.ts`,
  because nothing can enumerate it. Every id is verified against
  `pi auth check`, which answers `provider_not_found` for a typo — a test
  pins the three ids for that reason.

## The caveat the tab has to keep showing

pi's own providers doc says Anthropic subscription auth "draws from extra
usage and is billed per token, **not** against Claude plan limits". That is
the entire reason the Claude Code provider extension exists, so the row says
so and points at it. There is a test asserting the sentence survives, because
without it the tab quietly recommends the more expensive path.

Full background, including why Codex needs no CLI bridge at all and what
Anthropic's third-party OAuth ban does and does not cover, is in
[14-cli-providers.md](../cli-providers.md).
