# Signing in again closed the callback server before the browser reached it

Switching the ChatGPT (Codex) account from Settings → Accounts could not
succeed. The browser completed the sign-in and then landed on:

```
localhost refused to connect.
ERR_CONNECTION_REFUSED
http://localhost:1455/auth/callback?code=ac_N3IHRVZ2…&state=1f4aba6d…
```

The account row kept showing the old address, and `~/.pi/agent/auth.json` was
never rewritten.

This is the second time that page has appeared for a different reason. The
first was a shared five-minute budget that expired mid-sign-in
([2026-09-06-login-timeout-closed-the-callback-server.md](2026-09-06-login-timeout-closed-the-callback-server.md)).
That fix was correct and is untouched. It just did not cover the case where
the flow ends **early** rather than late.

## Cause

`electron/pi/login-flow.ts` decided a sign-in was complete by asking pi:

```ts
void checkProviderAuth(providerId).then((result) => {
  if (result.status === 'ready' && !settled) finish({ providerId, phase: 'signed-in' })
})
```

`ready` is the right fact for a first sign-in and the wrong one for a second.
"Sign in again" starts from a provider that is already signed in, so
`pi auth check` answers `ready` from the **old** credential the first time it
is asked — which is about a second after pi prints the authorization URL, and
the poll starts the moment that URL exists.

So the flow reported success while the user was still on OpenAI's page, and
`finish()` did what it does on every terminal state: `ptyManager.kill(ptyId)`.
That pty is pi, and pi is the loopback callback server on port 1455. The code
in the redirect was real and had nowhere to be redeemed.

Nothing on screen said so. Phosphor flipped the row to "Signed in" — truthfully,
about the account the user was trying to leave.

## Fix

Completion is now the credential **changing**, not the provider being ready.

`electron/pi/auth-identity.ts` gains `credentialFingerprint()`: a
sha256 digest, salted with a value randomised per process, so it is comparable
only within the run that produced it and matches nothing anywhere else. It
sits in the one file that is already allowed to look at a credential, and the
credential still goes no further.

`parseAuthCheck` carries the fingerprint alongside the account email.
`checkSubscriptionAuth` strips it before the status crosses IPC — the renderer
has no use for it and it is credential-derived.

The flow reads a baseline before it spawns the pty, and the decision is pure
and unit tested:

| before      | after            | new sign-in? |
| ----------- | ---------------- | ------------ |
| not ready   | ready            | yes          |
| ready `old` | ready `fresh`    | yes          |
| ready `old` | ready `old`      | no           |
| ready       | ready, no digest | no           |

A second sign-in to the _same_ account still completes, because the provider
issues a new token. The last row is deliberate: when there is nothing to
compare, waiting costs the browser budget, while guessing costs the user the
port they are mid-sign-in against. It should not arise in practice —
`--credentials` returns a credential for every provider pi reports ready, on
every version at or above `MIN_PI_VERSION`.

## Why the fingerprint, and not the email

The account email is already read out of the token, and comparing it would
have been less code. It answers the wrong question twice: signing back into
the same account is a legitimate sign-in that the email cannot see, and the
providers with opaque credentials (OpenRouter, Anthropic, GitHub) have no
email to compare at all. A digest changes whenever the credential does, which
is exactly the event being waited for.
