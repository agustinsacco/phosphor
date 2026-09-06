# 2026-09-06 — which account a provider is signed in as

The Accounts tab said "Signed in" and stopped there. With two ChatGPT logins on
one machine that is not enough to answer the only question worth asking: whose
usage is this spending? The Claude Code provider tab has shown an email per
account since [2026-08-27](2026-08-27-claude-account-in-app.md); this brings the
same fact to pi's own providers.

## Where the identity comes from

pi has no command for it. `pi auth check` answers ready / not_ready and nothing
about identity, `/login` is TUI-only, and the provider registry is not a package
export. What pi will hand over is the credential itself, via
`pi auth check --credentials`, and for a provider that issues a JWT the email is
a claim inside it.

So `electron/pi/auth-identity.ts` decodes the JWT payload and reads the email:
top-level `email` first, then any string one level deep that is email-shaped.
That second pass is what OpenAI needs — its claim is nested under the URL-shaped
key `https://api.openai.com/profile`, so a plain `claims.email` lookup finds
nothing.

Verified against real credentials (pi 0.84.2): `openai-codex` resolves to the
signed-in email, `openrouter` (an opaque `sk-or-…`) resolves to nothing and the
row keeps saying only "Signed in". Anthropic, GitHub and Kimi are opaque too.

## Two rules the code exists to enforce

- **The credential never leaves `parseAuthCheck`.** It arrives on that one JSON
  line, `accountFromCredential` reads an email out of it, and neither the
  returned object nor any log line carries the token. `SubscriptionProviderStatus.account`
  is an email or absent — never a secret. This is why the decode lives behind a
  narrow pure function instead of in the UI.
- **The signature is never checked, so this is a label and nothing else.** pi
  already decided the credential is good; we are only reading whose it is.
  Nothing may gate access on it.

Adding `--credentials` does put the token in main-process memory for the length
of one parse, on every settings open. That is the cost of the feature: the
alternative is a network round trip per provider, or no answer at all.
