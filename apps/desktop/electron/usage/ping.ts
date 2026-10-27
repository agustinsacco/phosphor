import { DEFAULT_CONTROL_URL } from '@shared/control-api'
import {
  parseUsagePingMarks,
  planUsagePing,
  sendUsagePing,
  usagePingOptedOut,
  type UsagePingMarks,
  type UsagePingPatch,
  type UsagePingSettings,
} from '@shared/usage-ping'

/** What main keeps on disk. Never sent and never shown to the renderer, apart from the switch. */
export interface UsageRecord {
  enabled: boolean
  noticeShown: boolean
  marks: UsagePingMarks | null
}

export interface UsagePingPorts {
  /** `app.isPackaged`. Dev runs, the browser harness and E2E never send. */
  packaged: boolean
  env: Readonly<Record<string, string | undefined>>
  version: string
  platform: string
  arch: string
  load: () => unknown
  save: (record: UsageRecord) => void
  fetch: typeof fetch
  now: () => Date
  random: () => number
  setTimeout: (run: () => void, ms: number) => { unref?: () => void }
  setInterval: (run: () => void, ms: number) => { unref?: () => void }
}

/** Not at launch: a few minutes in, so the ping never lines up with startup or a release. */
export const FIRST_PING_DELAY_MS = { min: 2 * 60_000, max: 10 * 60_000 }
/** An app left open across midnight pings once on the new day too. */
export const PING_RECHECK_MS = 6 * 3_600_000

const DAY_MS = 86_400_000

/**
 * The Desktop half of the anonymous daily usage ping (docs/usage-analytics.md).
 * On unless the user turns it off, but nothing is sent until the renderer has
 * shown the one-time notice, and never from an unpackaged build or when
 * `DO_NOT_TRACK` or `PHOSPHOR_NO_USAGE_PING` is set.
 */
export function createUsagePing(ports: UsagePingPorts) {
  const read = (): UsageRecord => {
    const raw = ports.load()
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    return {
      enabled: record.enabled !== false,
      noticeShown: record.noticeShown === true,
      marks: parseUsagePingMarks(record.marks),
    }
  }
  const blocked = (): UsagePingSettings['blocked'] =>
    !ports.packaged ? 'dev-build' : usagePingOptedOut(ports.env) ? 'environment' : null
  const plan = (marks: UsagePingMarks | null, now: Date) =>
    planUsagePing({
      product: 'desktop',
      version: ports.version,
      platform: ports.platform,
      arch: ports.arch,
      marks,
      now,
    })

  let sending = false
  async function tick(): Promise<void> {
    if (sending || blocked()) return
    const record = read()
    if (!record.enabled || !record.noticeShown) return
    const next = plan(record.marks, ports.now())
    if (!next) return
    sending = true
    try {
      // Marks move only on a counted ping, so a failed one is retried later today.
      if (await sendUsagePing(next.ping, { baseUrl: DEFAULT_CONTROL_URL, fetch: ports.fetch }))
        ports.save({ ...read(), marks: next.marks })
    } finally {
      sending = false
    }
  }

  let started = false
  return {
    tick,
    settings(): UsagePingSettings {
      const { enabled, noticeShown, marks } = read()
      const now = ports.now()
      // Already sent today: tomorrow's is the one that goes next.
      const next = plan(marks, now) ?? plan(marks, new Date(now.getTime() + DAY_MS))
      return { enabled, noticeShown, blocked: blocked(), preview: next?.ping ?? null }
    },
    set(patch: UsagePingPatch): UsagePingSettings {
      const record = read()
      ports.save({
        ...record,
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.noticeShown ? { noticeShown: true } : {}),
      })
      return this.settings()
    },
    /** Idempotent. No timer at all where nothing could be sent. */
    start(): void {
      if (started || blocked()) return
      started = true
      const { min, max } = FIRST_PING_DELAY_MS
      // Best effort: a ping that can't be sent or saved is tried again later.
      const run = () => {
        tick().catch(() => undefined)
      }
      ports.setTimeout(run, min + Math.floor(ports.random() * (max - min))).unref?.()
      ports.setInterval(run, PING_RECHECK_MS).unref?.()
    },
  }
}

export type DesktopUsagePing = ReturnType<typeof createUsagePing>
