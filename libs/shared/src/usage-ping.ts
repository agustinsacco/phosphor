/**
 * The sending side of the anonymous daily usage ping, shared by Desktop and the
 * Host. The wire shape and its parser live in `./control-api` (`UsagePing`).
 *
 * A sender keeps three marks on its own disk: the UTC day, ISO week and month
 * of its last counted ping. The marks never leave the machine. The ping carries
 * only booleans derived from them, so the server learns "first this week", never
 * when, and nothing in it names the install.
 *
 * Pure apart from the injected `fetch`: no node:, no electron.
 */

import {
  ARCHES,
  CONTROL_ROUTES,
  isReleaseVersion,
  PLATFORMS,
  type UsagePing,
  type UsageProduct,
} from './control-api'

/** Kept on the sender's disk, never sent. All UTC. */
export interface UsagePingMarks {
  /** YYYY-MM-DD */
  readonly day: string
  /** YYYY-Www, ISO 8601 week */
  readonly week: string
  /** YYYY-MM */
  readonly month: string
}

/** Settings → Advanced → Privacy, as Desktop's main process reports it. */
export interface UsagePingSettings {
  /** The user's switch: on unless turned off. */
  readonly enabled: boolean
  /** The one-time notice has been shown. Nothing is sent before it. */
  readonly noticeShown: boolean
  /** Why nothing is sent whatever the switch says, or null. */
  readonly blocked: 'dev-build' | 'environment' | null
  /** Exactly what the next ping carries; null when there is none to send. */
  readonly preview: UsagePing | null
}
export interface UsagePingPatch {
  readonly enabled?: boolean
  /** Only ever set: the notice is shown once. */
  readonly noticeShown?: true
}
export function parseUsagePingPatch(value: unknown): UsagePingPatch | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { enabled, noticeShown, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length > 0) return null
  if (enabled !== undefined && typeof enabled !== 'boolean') return null
  if (noticeShown !== undefined && noticeShown !== true) return null
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(noticeShown ? { noticeShown } : {}),
  }
}

const pad = (value: number) => String(value).padStart(2, '0')
const utcDay = (now: Date) => now.toISOString().slice(0, 10)

/** ISO 8601 week, UTC: weeks start Monday, and week 1 holds the year's first Thursday. */
export function isoWeek(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const weekday = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - weekday)
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${pad(week)}`
}

export function usageMarks(now: Date): UsagePingMarks {
  return { day: utcDay(now), week: isoWeek(now), month: utcDay(now).slice(0, 7) }
}

export function parseUsagePingMarks(value: unknown): UsagePingMarks | null {
  if (typeof value !== 'object' || value === null) return null
  const { day, week, month } = value as Record<string, unknown>
  return typeof day === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    typeof week === 'string' &&
    /^\d{4}-W\d{2}$/.test(week) &&
    typeof month === 'string' &&
    /^\d{4}-\d{2}$/.test(month)
    ? { day, week, month }
    : null
}

export interface UsagePingInput {
  readonly product: UsageProduct
  readonly version: string
  /** `process.platform` and `process.arch`, checked here. */
  readonly platform: string
  readonly arch: string
  /** The last counted ping's marks, or null if this install never sent one. */
  readonly marks: UsagePingMarks | null
  readonly now: Date
}

/**
 * Today's ping and the marks to keep once it is counted, or null when there is
 * nothing to send: already sent today, a clock that moved back, a dev or
 * prerelease version, or a platform the counters don't know.
 */
export function planUsagePing(
  input: UsagePingInput,
): { ping: UsagePing; marks: UsagePingMarks } | null {
  const { platform, arch, version, marks: last } = input
  if (!isReleaseVersion(version)) return null
  const os = PLATFORMS.find((value) => value === platform)
  const cpu = ARCHES.find((value) => value === arch)
  if (!os || !cpu) return null
  const marks = usageMarks(input.now)
  if (last && last.day >= marks.day) return null
  return {
    ping: {
      v: 1,
      product: input.product,
      version,
      os,
      arch: cpu,
      first: last === null,
      newWeek: last?.week !== marks.week,
      newMonth: last?.month !== marks.month,
    },
    marks,
  }
}

const set = (value: string | undefined) =>
  value !== undefined && !['', '0', 'false', 'no'].includes(value.trim().toLowerCase())

/** `DO_NOT_TRACK` (consoledonottrack.com) or `PHOSPHOR_NO_USAGE_PING` turns the ping off. */
export const usagePingOptedOut = (env: Readonly<Record<string, string | undefined>>): boolean =>
  set(env.DO_NOT_TRACK) || set(env.PHOSPHOR_NO_USAGE_PING)

/**
 * POSTs the ping with no credentials, cookies, Origin or account header: the
 * server refuses a ping that carries Origin or Authorization. True only when
 * the server answered 204, which is when the sender should keep the new marks.
 */
export async function sendUsagePing(
  ping: UsagePing,
  ports: { baseUrl: string; fetch: typeof fetch; timeoutMs?: number },
): Promise<boolean> {
  try {
    const response = await ports.fetch(new URL(CONTROL_ROUTES.usagePing, ports.baseUrl), {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(ports.timeoutMs ?? 10_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ping),
    })
    await response.body?.cancel().catch(() => undefined)
    return response.status === 204
  } catch {
    return false
  }
}
