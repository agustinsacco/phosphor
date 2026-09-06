/**
 * Which account a provider is signed in as.
 *
 * pi has no command for this: `pi auth check` answers ready/not_ready and
 * nothing about identity, and the provider registry is not a package export.
 * What pi *will* hand over is the credential itself (`--credentials`), and for
 * an OAuth provider that issues a JWT the email is a claim inside it. So the
 * account line under "Signed in" is read from the token, locally, with no
 * network call and no extra process.
 *
 * Two rules this file exists to enforce:
 *
 * - **The credential never leaves here.** Callers pass the secret in and get
 *   back an email or nothing. Nothing else in pidex holds it, logs it, or
 *   sends it to the renderer.
 * - **A signature is never checked, so nothing here may be trusted for
 *   access.** This is a display label. pi already decided the credential is
 *   good; we are only reading whose it is.
 *
 * Providers whose credential is opaque (OpenRouter's `sk-or-…`, Anthropic's
 * `sk-ant-oat…`, a GitHub token) simply have no account to show, and the row
 * keeps saying "Signed in" and nothing more.
 */

/** Deliberately loose: this labels a row, it does not validate an address. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A JWT big enough to be worth decoding, small enough not to be a payload. */
const MAX_CREDENTIAL_CHARS = 16_384

/**
 * The email a JWT credential was issued to, if it carries one.
 *
 * Pure and total — this runs for every provider on every settings open, and a
 * credential shape we have never seen must produce `undefined`, not a throw.
 */
export function accountFromCredential(credential: unknown): string | undefined {
  if (typeof credential !== 'string') return undefined
  if (credential.length === 0 || credential.length > MAX_CREDENTIAL_CHARS) return undefined

  const claims = decodeJwtClaims(credential)
  if (!claims) return undefined

  // Two passes, because OpenAI namespaces the claim
  // (`https://api.openai.com/profile` → `email`) while a plain OIDC token puts
  // `email` at the top. Prefer a value whose key actually says "email" over
  // any old email-shaped string, so a token that happens to carry a support
  // address somewhere cannot outrank the real one.
  const values = collectStrings(claims)
  const named = values.find(([key, value]) => key.toLowerCase() === 'email' && EMAIL.test(value))
  if (named) return named[1]
  return values.find(([, value]) => EMAIL.test(value))?.[1]
}

/** The payload segment of a JWT, parsed. `undefined` for anything else. */
function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const segments = token.split('.')
  if (segments.length !== 3) return undefined
  const payload = segments[1]
  if (!payload) return undefined
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Every string claim, one level of nesting deep, as `[lastKeySegment, value]`. */
function collectStrings(claims: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = []
  for (const [key, value] of Object.entries(claims)) {
    if (typeof value === 'string') {
      out.push([lastSegment(key), value])
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (typeof nestedValue === 'string') out.push([lastSegment(nestedKey), nestedValue])
      }
    }
  }
  return out
}

/** `https://api.openai.com/profile.email` is a claim named "email". */
function lastSegment(key: string): string {
  return key.split(/[./]/).at(-1) ?? key
}
