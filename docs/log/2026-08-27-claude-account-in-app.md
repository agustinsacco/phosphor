# Switching the Claude account without a terminal

> **Superseded 2026-09-04.** The "exactly one credential" premise below is
> wrong: `CLAUDE_SECURESTORAGE_CONFIG_DIR` scopes the CLI's keychain entry, so
> Phosphor now keeps several accounts and routes sessions between them. See
> [2026-09-04-claude-multi-account.md](2026-09-04-claude-multi-account.md).

Date: 2026-08-27

## What changed

Settings → **Claude Code provider** → the _Claude account_ row is now a control,
not a label. It shows who is signed in (email · plan · org), and offers
**Sign in** / **Switch account** / **Sign out**. It used to read:

> not logged in — run `claude` in a terminal and use /login

That instruction was correct and it was the whole problem: the one provider
Phosphor recommends for plan-limit billing was also the only one whose sign-in
required leaving the app, while pi's own OAuth providers had had in-app buttons
in the Accounts tab since 2026-08-26.

## Why this one needs no pty

The Accounts tab drives pi's TUI off-screen through a 1000-column pty
(`electron/pi/login-flow.ts`) because pi's `/login` exists nowhere else. None of
that machinery is needed here. `claude auth login` is a plain subcommand and it
works with **piped stdio** — verified against Claude Code 2.1.231:

```
$ printf 'code\n' | claude auth login
Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…
Paste code here if prompted > Invalid code. Please make sure the full code was copied.
```

So `electron/pi/claude-login.ts` is an ordinary `spawn` with pipes: read the URL
off stdout, let the user finish in their browser, write the code they paste back
into stdin. No screen classification, no keystroke timing, no terminal width
trap.

## Three things the real CLI taught us

Each was found by running it, and each is a line of code plus a test:

- **The CLI opens the browser itself.** So main deliberately does _not_ call
  `openExternal` on the URL — two tabs means a user pasting a code from the
  stale one. The UI keeps the link as a "browser didn't open?" fallback.
- **A rejected code is not fatal.** It prints `Invalid code.` and restarts the
  handshake with a **new PKCE challenge**. The flow therefore returns to
  `awaiting-code` with `invalidCode: true`, and the URL parser takes the _last_
  match — a code pasted from the first URL can never succeed.
- **Its prose is not the outcome.** A run given a bogus code still printed
  `Login successful.` and exited 0. Completion is decided by
  `claude auth status`, the same fact the rest of Phosphor already trusts — the
  identical rule `login-flow.ts` arrived at for pi.

That last one has a subtlety worth keeping: on a **switch**, `auth status` says
`loggedIn` for the account you were already on, so "logged in" alone is not
proof. The flow records the email before starting and rejects a result that
names the same account after a rejected code.

## Why there is no "Add account"

The `claude` CLI holds exactly one credential — on macOS a single keychain item
(`Claude Code-credentials`, keyed by OS user, not by `CLAUDE_CONFIG_DIR`). Two
Claude accounts side by side is not reachable from here; it is
[cli-providers.md](../cli-providers.md) Phase B, in the provider
package. So the row says **Switch account**, which is what it does, instead of
offering a button that would silently replace the credential.

## Verification

- `electron/pi/claude-login.test.ts` — 7 tests pinning the URL parser and the
  invalid-code notice against verbatim 2.1.231 captures, including the
  newest-URL-wins case.
- The whole flow is mocked in `src/dev/mockPhosphor.ts` (`claude:*` channels), so
  the paste-code box, a rejected code, and the row flipping to a new account are
  developable in `npm run dev:web` without a `claude` install. Submitting the
  literal code `bad` replays the rejection.
- `e2e/smoke.spec.ts` drives the whole thing against a stub `claude` that reads
  the code from stdin: Switch account → paste-code box → Continue → settled row.
  That is a real subprocess over piped stdio, which is the part no unit test can
  reach.
- `npm run validate`: typecheck, lint, format, 1219 unit tests, e2e all green.
