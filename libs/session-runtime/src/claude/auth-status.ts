import type { ClaudeAuthStatus } from '@shared/models'

/** CLI output can contain noise. Project named identity fields, never arbitrary auth output. */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus {
  const start = stdout.indexOf('{')
  if (start === -1) return { ok: false, error: 'no auth status' }
  try {
    const parsed = JSON.parse(stdout.slice(start)) as Record<string, unknown> | null
    // A transient CLI failure is unavailable, not evidence that credentials vanished.
    if (!parsed || typeof parsed.loggedIn !== 'boolean')
      return { ok: false, error: 'auth status unavailable' }
    return {
      ok: true,
      loggedIn: parsed.loggedIn === true,
      orgId: typeof parsed.orgId === 'string' ? parsed.orgId : undefined,
      plan: typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : undefined,
      organization: typeof parsed.orgName === 'string' ? parsed.orgName : undefined,
      method: typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined,
      email: typeof parsed.email === 'string' ? parsed.email : undefined,
    }
  } catch {
    return { ok: false, error: 'unparseable auth status output' }
  }
}
