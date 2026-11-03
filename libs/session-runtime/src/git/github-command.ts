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
    const json = stdout.indexOf('{')
    return { ok: true, stdout: json >= 0 ? stdout.slice(json) : stdout }
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
    return {
      ok: false,
      reason: signal.aborted || e.killed ? 'timeout' : 'unavailable',
      retryWithoutChecks: /resource limits|query.*complex|couldn't respond.*time/i.test(output),
    }
  }
}
