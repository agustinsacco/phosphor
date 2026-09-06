# A sign-in timeout closed the port the browser was redirecting to

Signing pi into OpenAI Codex from Settings → Accounts failed with two messages
that did not obviously describe the same event. pidex said "Sign-in timed out."
The browser said:

```
localhost refused to connect.
ERR_CONNECTION_REFUSED
http://localhost:1455/auth/callback?code=ac_X6_…&state=c439447f…
```

The URL was valid and the code was real. Nothing was listening for it.

## Evidence

At the moment of the failure:

```
$ lsof -nP -iTCP:1455
(nothing listening)
$ pgrep -lf 'ChatGPT|Codex'
(no output)
```

No process held port 1455, and no login was in flight.

## Cause

`electron/pi/login-flow.ts` drives pi's `/login` TUI in a hidden pty. Two of
pi's providers use a **loopback redirect** rather than a device code: pi binds
a port on `localhost`, prints an authorization URL carrying that port as
`redirect_uri`, and the browser completes the exchange against pi directly.
OpenAI Codex is one of them, on the fixed port 1455.

That callback server is pi. pi is the pty. So `ptyManager.kill(ptyId)` — which
`finish()` calls on every terminal state — closes the port.

The flow had a single budget:

```ts
const FLOW_TIMEOUT_MS = 5 * 60_000 // whole flow, including the human
```

measured from launch and covering both the TUI driving and the browser trip.
An enterprise SSO round trip (identity provider, MFA, account picker) does not
reliably fit in what is left of five minutes. When it expired, pidex killed pi
mid-sign-in and tore down the port the user's browser was seconds from hitting.

Neither message named the cause. pidex reported a timeout without saying it had
just closed a server; the browser reported a refused connection without knowing
why the server was gone.

## Fix

Split the budget, because the two halves fail for different reasons and deserve
different patience:

| Budget  | Covers                       | Was          | Now                               |
| ------- | ---------------------------- | ------------ | --------------------------------- |
| setup   | launch → authorization URL   | shared 5 min | 2 min                             |
| browser | authorization URL → callback | shared 5 min | 15 min, restarted on each new URL |

`expiredBudget(now, startedAt, authAt)` is the pure decision and is unit
tested. The browser clock starts when pi emits a URL, so a slow setup cannot
shorten the human's trip, and a re-issued URL restarts it — the previous one is
spent. The flow is still bounded; it just no longer spends the human's budget
on machine work.

The timeout message now names what pidex did, since the browser cannot:

> Sign-in timed out waiting for your browser, so pidex closed pi's callback
> server. If your browser now says it cannot reach localhost, that is why —
> start the sign-in again.

`electron/pi/claude-login.ts` had the same constant and the same shape. Killing
that child ends the sign-in outright, because the CLI is the only thing that can
redeem the code the user is about to paste. Its clock is now restarted on every
URL the CLI offers, which also covers the invalid-code path where the CLI
restarts the handshake with a fresh PKCE challenge.

## Audit: which binary each account flow drives

Checked at the same time, since the failure looked like it might be the Codex
desktop app rather than pi. It was not — the two flows are correctly separated,
and they sign into different credential stores:

| Surface                    | Drives                     | Writes                     |
| -------------------------- | -------------------------- | -------------------------- |
| Settings → Accounts        | pi's `/login` TUI in a pty | `~/.pi/agent/auth.json`    |
| Settings → Claude provider | `claude auth login`        | the Claude CLI's own store |

Neither launches a vendor desktop app. `~/.codex/auth.json` — the Codex desktop
app's own credential — is not read or written by pidex at all, and a login there
has no effect on pi. The two can be, and were, signed into different accounts.

## Still missing

The Accounts tab reports **that** a provider is signed in, never **which
account**. `pi auth check --json` returns only `{status, provider, authType}`,
so the identity would have to come from `--credentials` and a decoded JWT —
which puts a bearer token in pidex's main process, so it is deliberately not
done here. This is already the "show which account is signed in" item in
[cli-providers.md](../cli-providers.md).

Until then, a provider row that says "Signed in" cannot tell a personal account
from a work one, which is how a machine ends up running one account in pi and a
different one in the vendor app without anything on screen saying so.
