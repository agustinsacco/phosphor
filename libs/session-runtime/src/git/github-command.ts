import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GhPrFailure } from '@phosphor/shared/models'

export type GithubCommandResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: GhPrFailure; retryAfterMs?: number; retryWithoutChecks?: boolean }
export type GithubCommand = (
  cwd: string,
  args: string[],
  signal: AbortSignal,
) => Promise<GithubCommandResult>

export class GithubFailure extends Error {
  constructor(
    readonly reason: GhPrFailure,
    readonly retryWithoutChecks = false,
  ) {
    super(reason)
  }
}

const exec = promisify(execFile)
const HEADERS = /^HTTP\/[\s\S]*?\r?\n\r?\n/

/**
 * gh exits 1 when any alias in a GraphQL query fails, even when the rest
 * answered. A reply whose only errors are NOT_FOUND is still an answer: it is
 * how GitHub says one PR number does not exist. Callers that reject `errors`
 * keep doing so.
 */
function notFoundOnly(args: string[], stdout: string | undefined): string | null {
  if (args[0] !== 'api' || args[1] !== 'graphql' || !stdout) return null
  const body = stdout.replace(HEADERS, '')
  try {
    const value = JSON.parse(body) as { data?: unknown; errors?: { type?: unknown }[] }
    return value?.data &&
      Array.isArray(value.errors) &&
      value.errors.length > 0 &&
      value.errors.every((error) => error?.type === 'NOT_FOUND')
      ? body
      : null
  } catch {
    return null
  }
}
/** One machine-side adapter. No stderr, credentials or provider messages cross the wire. */
export async function runGithubCommand(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<GithubCommandResult> {
  try {
    const { stdout } = await exec('gh', args, {
      cwd,
      env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      signal,
      timeout: 8_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    // `gh api --include` exposes retry headers on failures; successful payloads
    // still enter the same JSON parser as repo-view responses.
    // Only `gh api --include` emits HTTP headers. Ordinary gh JSON may be an array.
    const body = args.includes('--include') ? stdout.replace(HEADERS, '') : stdout
    return { ok: true, stdout: body }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; killed?: boolean }
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`
    if (/rate limit|HTTP 429|secondary rate/i.test(output)) {
      const retry = /retry-after:\s*(\d+)/i.exec(output)
      const reset = /x-ratelimit-reset:\s*(\d+)/i.exec(output)
      return {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: retry
          ? Math.max(60_000, Number(retry[1]) * 1000)
          : reset
            ? Math.max(60_000, Number(reset[1]) * 1000 - Date.now())
            : 60_000,
      }
    }
    const partial = signal.aborted ? null : notFoundOnly(args, e.stdout)
    if (partial) return { ok: true, stdout: partial }
    return {
      ok: false,
      reason: signal.aborted || e.killed ? 'timeout' : 'unavailable',
      retryWithoutChecks: /resource limits|query.*complex|couldn't respond.*time/i.test(output),
    }
  }
}
