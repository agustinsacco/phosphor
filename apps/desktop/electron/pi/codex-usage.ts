import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CodexUsageResult, PlanUsageWindow } from '@shared/models'
import { credentialFingerprint } from '@phosphor/session-runtime/pi/auth-identity'
import { checkPiHealth } from './health'
import { piProcessEnv } from './shell-env'
import { piStubPath } from './stub'

const execFileAsync = promisify(execFile)
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CACHE_MS = 60_000
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const resetTime = (value: unknown): number | null =>
  finite(value) && value > 0 && value <= 8_640_000_000_000 ? value * 1000 : null

/** OpenAI's Codex client uses this same read-only endpoint. Do not infer a
 * window's duration from primary/secondary: some plans have only a weekly primary. */
export function parseCodexUsage(value: unknown, now = Date.now()): CodexUsageResult {
  const data = record(value)
  const limits = record(data.rate_limit)
  const windows: PlanUsageWindow[] = []
  for (const key of ['primary_window', 'secondary_window']) {
    const w = record(limits[key])
    const seconds = w.limit_window_seconds
    if (!finite(w.used_percent) || w.used_percent < 0 || w.used_percent > 100) continue
    if (!finite(seconds) || seconds <= 0) continue
    const kind = seconds === 18_000 ? 'five_hour' : seconds === 604_800 ? 'weekly' : 'other'
    windows.push({
      label: kind === 'weekly' ? 'Weekly' : `${seconds / 3600}-hour`,
      kind,
      percentUsed: w.used_percent,
      resetsAt: resetTime(w.reset_at),
    })
  }
  const individual = record(record(data.spend_control).individual_limit)
  const amount = (value: unknown): number | null => {
    const n = typeof value === 'string' && value.trim() ? Number(value) : value
    return finite(n) && n >= 0 ? n : null
  }
  const limit = amount(individual.limit)
  const remaining = amount(individual.remaining)
  const credits =
    individual.unit === 'credit' && limit !== null && remaining !== null
      ? { limit, remaining, resetsAt: resetTime(individual.reset_at) }
      : null
  if (!windows.length && !credits) return { ok: false, error: 'no-usage' }
  return { ok: true, snapshot: { fetchedAt: now, windows, credits } }
}

/** pi owns storage and OAuth refresh. Secrets are captured only in main memory;
 * never log subprocess errors (they may contain stdout), tokens or response bodies. */
async function readAuth(): Promise<string> {
  const stub = piStubPath()
  const health = stub
    ? { ok: true, binaryPath: process.execPath, prefixArgs: [stub] }
    : await checkPiHealth()
  if (!health.ok || !health.binaryPath) throw new Error('pi unavailable')
  const { stdout } = await execFileAsync(
    health.binaryPath,
    [
      ...(health.prefixArgs ?? []),
      'auth',
      'check',
      '--provider',
      'openai-codex',
      '--json',
      '--credentials',
    ],
    {
      env: await piProcessEnv(stub ? { ELECTRON_RUN_AS_NODE: '1' } : undefined),
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    },
  )
  return stdout
}

/** Bounded cache and single-flight across popovers. Resolve auth before cache
 * lookup so signing out/changing accounts cannot reuse the previous login's usage. */
export function createCodexUsageReader(
  auth = readAuth,
  request: typeof fetch = (url, options) => fetch(url, options),
): (force?: boolean) => Promise<CodexUsageResult> {
  let cached: { key: string; at: number; result: CodexUsageResult } | undefined
  let pending: Promise<CodexUsageResult> | undefined
  async function load(force: boolean): Promise<CodexUsageResult> {
    let token: string
    let accountId: string
    try {
      const response = record(JSON.parse((await auth()).trim().split('\n').at(-1) ?? ''))
      if (
        response.status !== 'ready' ||
        response.authType !== 'oauth' ||
        typeof response.credentials !== 'string'
      ) {
        return { ok: false, error: 'auth-unavailable' }
      }
      token = response.credentials
      const claims = record(
        JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')),
      )
      const id = record(claims['https://api.openai.com/auth']).chatgpt_account_id
      if (typeof id !== 'string' || !id.trim()) return { ok: false, error: 'auth-unavailable' }
      accountId = id
    } catch {
      return { ok: false, error: 'auth-unavailable' }
    }
    const key = credentialFingerprint(token)!
    if (!force && cached?.key === key && Date.now() - cached.at < CACHE_MS) return cached.result
    try {
      const response = await request(USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': accountId },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok)
        return {
          ok: false,
          error:
            response.status === 401 || response.status === 403
              ? 'auth-unavailable'
              : response.status === 429
                ? 'rate-limited'
                : 'request-failed',
        }
      const result = parseCodexUsage(await response.json())
      if (result.ok) cached = { key, at: Date.now(), result }
      return result
    } catch {
      return { ok: false, error: 'request-failed' }
    }
  }
  return (force = false) => {
    pending ??= load(force).finally(() => {
      pending = undefined
    })
    return pending
  }
}

export const fetchCodexUsage = createCodexUsageReader()
