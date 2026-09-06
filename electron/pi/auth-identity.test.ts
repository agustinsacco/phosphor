import { describe, expect, it } from 'vitest'
import { accountFromCredential } from './auth-identity'

/** Build a JWT-shaped string whose payload is `claims`. Signature is junk. */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.c2ln`
}

describe('accountFromCredential', () => {
  it('reads the namespaced claim a real Codex token carries', () => {
    // Claim layout captured from a live `pi auth check --provider
    // openai-codex --credentials` token; the email is nested under a
    // URL-shaped key, which is why a plain `claims.email` lookup finds nothing.
    const token = jwt({
      'https://api.openai.com/auth': { chatgpt_plan_type: 'self_serve_business_usage_based' },
      'https://api.openai.com/profile': { email: 'user@example.com', email_verified: true },
      sub: 'samlp|prof_01K3|user@example.com',
    })
    expect(accountFromCredential(token)).toBe('user@example.com')
  })

  it('reads a plain OIDC email claim', () => {
    expect(accountFromCredential(jwt({ email: 'plain@example.com' }))).toBe('plain@example.com')
  })

  it('prefers a claim actually named email over any email-shaped string', () => {
    const token = jwt({ support_contact: 'help@vendor.test', email: 'me@example.com' })
    expect(accountFromCredential(token)).toBe('me@example.com')
  })

  it('falls back to an email-shaped claim when none is named email', () => {
    expect(accountFromCredential(jwt({ upn: 'upn@example.com' }))).toBe('upn@example.com')
  })

  it('has nothing to show for an opaque credential', () => {
    // OpenRouter and Anthropic hand out opaque tokens; the row stays at
    // "Signed in" rather than inventing an account.
    for (const opaque of ['sk-or-v1-abcdef', 'sk-ant-oat01-abcdef', 'gho_abcdef']) {
      expect(accountFromCredential(opaque)).toBeUndefined()
    }
  })

  it('degrades to undefined rather than throwing', () => {
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'a.b.c',
      'a..c',
      jwt([] as never),
      'x'.repeat(20000),
    ]) {
      expect(accountFromCredential(bad)).toBeUndefined()
    }
  })

  it('never returns a claim that is not an address', () => {
    // A user id, an account uuid and an issuer are all strings; none of them
    // is something to show a user as "the account you are signed in as".
    const token = jwt({ sub: 'user-jGhfnaJ', account_id: 'b13dd77f-1117', iss: 'https://auth.x' })
    expect(accountFromCredential(token)).toBeUndefined()
  })
})
