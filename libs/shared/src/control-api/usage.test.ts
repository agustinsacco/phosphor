import { describe, expect, it } from 'vitest'
import {
  ADMIN_SERIES_DAYS,
  DOWNLOAD_ARTIFACTS,
  downloadPath,
  isReleaseVersion,
  parseAdminStats,
  parseUsagePing,
} from '../control-api'
import * as facade from '../control-api'
import * as usage from './usage'

const ping = {
  v: 1,
  product: 'desktop',
  version: '0.1.542',
  os: 'darwin',
  arch: 'arm64',
  first: false,
  newWeek: true,
  newMonth: false,
}

describe('usage ping', () => {
  it('accepts exactly the documented payload', () => {
    expect(parseUsagePing(ping)).toEqual({ ok: true, value: ping })
    expect(parseUsagePing({ ...ping, product: 'host', os: 'linux', arch: 'x64' }).ok).toBe(true)
  })

  it('refuses any extra or missing key, so nothing can ride along', () => {
    expect(parseUsagePing({ ...ping, installId: 'abc' })).toEqual({ ok: false, reason: 'keys' })
    expect(parseUsagePing({ ...ping, hostname: 'bee2' }).ok).toBe(false)
    const { first: _first, ...missing } = ping
    expect(parseUsagePing(missing).ok).toBe(false)
  })

  it('refuses dev versions, unknown enums and non-boolean flags', () => {
    for (const bad of [
      { version: '0.1.542-dev' },
      { version: '0.1' },
      { version: 1 },
      { product: 'web' },
      { os: 'freebsd' },
      { arch: 'ia32' },
      { v: 2 },
      { first: 'false' },
      { newWeek: 1 },
      { newMonth: null },
    ])
      expect(parseUsagePing({ ...ping, ...bad }).ok, JSON.stringify(bad)).toBe(false)
    expect(parseUsagePing(null).ok).toBe(false)
    expect(parseUsagePing([ping]).ok).toBe(false)
  })

  it('treats only plain x.y.z as a release version', () => {
    expect(isReleaseVersion('0.2.16')).toBe(true)
    expect(isReleaseVersion('0.2.16+abc')).toBe(false)
    expect(isReleaseVersion('v0.2.16')).toBe(false)
  })
})

describe('download paths', () => {
  it('names each artifact under /download/', () => {
    expect(downloadPath('install-sh')).toBe('/download/install-sh')
    for (const artifact of DOWNLOAD_ARTIFACTS) expect(artifact).toMatch(/^[a-z0-9-]{1,32}$/)
  })
})

const totals = { day: 1, week: 2, lastWeek: 3, month: 4, lastMonth: 5, new7d: 6, new30d: 7 }
const stats = {
  generatedAt: '2026-10-27T12:00:00.000Z',
  accounts: { total: 12, new7d: 1, new30d: 3 },
  hosts: { enrolled: 4, online: 2, seen24h: 3 },
  downloads: {
    last7d: 9,
    last30d: 40,
    total: 100,
    byArtifact30d: [{ artifact: 'install-sh', downloads: 30 }],
  },
  usage: { desktop: totals, host: totals },
  series: [{ day: '2026-10-27', desktop: 5, host: 2, installs: 1, downloads: 3 }],
  versions: [
    { product: 'desktop', version: '0.1.542', pings: 10 },
    { product: 'host', version: '0.2.16', pings: null },
  ],
  platforms: [{ product: 'desktop', os: 'darwin', arch: 'arm64', pings: 8 }],
}

describe('admin stats', () => {
  it('parses the aggregate summary', () => {
    expect(parseAdminStats(stats)).toEqual({ ok: true, value: stats })
  })

  it('drops unknown fields, so nothing unlisted reaches the page', () => {
    const parsed = parseAdminStats({
      ...stats,
      users: [{ login: 'someone' }],
      accounts: { ...stats.accounts, logins: ['someone'] },
    })
    expect(parsed.ok && parsed.value).toEqual(stats)
  })

  it('refuses a small cell that was not suppressed', () => {
    for (const pings of [1, 2, -1, 1.5, '3'])
      expect(
        parseAdminStats({ ...stats, versions: [{ ...stats.versions[0], pings }] }).ok,
        String(pings),
      ).toBe(false)
  })

  it('bounds the series and refuses malformed days and counts', () => {
    const day = stats.series[0]!
    const long = Array.from({ length: ADMIN_SERIES_DAYS + 1 }, () => day)
    expect(parseAdminStats({ ...stats, series: long }).ok).toBe(false)
    expect(parseAdminStats({ ...stats, series: [{ ...day, day: '2026-02-30' }] }).ok).toBe(false)
    expect(parseAdminStats({ ...stats, hosts: { ...stats.hosts, online: -1 } }).ok).toBe(false)
    expect(parseAdminStats({ ...stats, usage: { desktop: totals } }).ok).toBe(false)
    expect(parseAdminStats({ ...stats, generatedAt: 'now' }).ok).toBe(false)
  })
})

describe('usage module', () => {
  it('is what the control-api entry exports', () => {
    for (const name of Object.keys(usage))
      expect(facade[name as keyof typeof facade], name).toBe(usage[name as keyof typeof usage])
    expect(Object.keys(usage).sort()).toEqual([
      'ADMIN_BREAKDOWN_ROWS',
      'ADMIN_SERIES_DAYS',
      'DOWNLOAD_ARTIFACTS',
      'DOWNLOAD_PATH_PREFIX',
      'USAGE_PRODUCTS',
      'downloadPath',
      'isReleaseVersion',
      'parseAdminStats',
      'parseUsagePing',
    ])
  })
})
