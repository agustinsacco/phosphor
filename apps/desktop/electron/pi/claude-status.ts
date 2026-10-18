import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ClaudeAuthStatus, ClaudeStatus } from '@shared/models'
import { piProcessEnv } from './shell-env'
import { resolveBinary } from './binary-lookup'

const execFileAsync = promisify(execFile)

/**
 * Parse `claude auth status` output (JSON on Claude Code 2.x). Tolerates
 * leading noise before the JSON object and non-JSON output from older CLIs.
 */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus {
  const start = stdout.indexOf('{')
  if (start === -1) return { ok: false, error: stdout.trim().slice(0, 200) || 'no output' }
  try {
    const parsed = JSON.parse(stdout.slice(start)) as {
      loggedIn?: unknown
      authMethod?: unknown
      email?: unknown
      subscriptionType?: unknown
      orgName?: unknown
      orgId?: unknown
    }
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

/** Extract a version like "2.1.219" from mixed CLI output. */
function versionFrom(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(output)?.[1]
}

/**
 * Claude Code CLI health for the provider tab: binary presence + version and
 * local auth state. `claude auth status` reads local credentials only (no
 * network round-trip), so probing on tab mount is fine.
 */
export async function claudeStatus(
  claudeOverride?: string,
  /** Credential-scoping env for one account; see electron/claude/accounts.ts. */
  extraEnv?: Record<string, string>,
): Promise<ClaudeStatus> {
  const path = claudeOverride ?? (await resolveBinary('claude'))
  if (!path) return { binary: { found: false }, auth: { ok: false, error: 'claude not found' } }

  const env = { ...(await piProcessEnv()), ...extraEnv }
  let version: string | undefined
  try {
    const { stdout } = await execFileAsync(path, ['--version'], { timeout: 10_000, env })
    version = versionFrom(stdout)
  } catch {
    // Version is cosmetic; auth state below is the load-bearing part.
  }

  try {
    const { stdout } = await execFileAsync(path, ['auth', 'status'], { timeout: 10_000, env })
    return { binary: { found: true, path, version }, auth: parseClaudeAuthStatus(stdout) }
  } catch (error) {
    const failure = error as { stdout?: string; message: string }
    // Non-zero exit still prints the status JSON when logged out.
    const auth = failure.stdout
      ? parseClaudeAuthStatus(failure.stdout)
      : { ok: false, error: failure.message }
    return { binary: { found: true, path, version }, auth }
  }
}
