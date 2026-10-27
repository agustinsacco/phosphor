/**
 * Anonymous usage counts and the owner-only admin summary built from them.
 * Reached through `../control-api`.
 *
 * A ping names no install, account, machine or address: only the product, its
 * release version, OS, architecture and three flags the sender derives from its
 * own last-ping dates. The server adds it to per-day counters and keeps nothing
 * else, so no stored row is about one install.
 *
 * Unlike the other control-api parsers, `parseUsagePing` refuses unknown keys,
 * so nothing extra can ride along with a ping by accident.
 */

import { fail, isCount, isIsoTime, isRecord, ok, oneOf, type Parsed } from './fields'
import { ARCHES, PLATFORMS, type Arch, type Platform } from './types'

export const USAGE_PRODUCTS = ['desktop', 'host'] as const
export type UsageProduct = (typeof USAGE_PRODUCTS)[number]

/**
 * `/download/<artifact>` on the site origin, each a counted redirect to GitHub:
 * `latest` to the latest release page, `install-sh` to its install script.
 */
export const DOWNLOAD_ARTIFACTS = ['latest', 'install-sh'] as const
export type DownloadArtifact = (typeof DOWNLOAD_ARTIFACTS)[number]
export const DOWNLOAD_PATH_PREFIX = '/download/'
export const downloadPath = (artifact: DownloadArtifact): string =>
  `${DOWNLOAD_PATH_PREFIX}${artifact}`

/** Release builds only: a prerelease or dev suffix never reaches the counters. */
const releaseVersion = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/
export const isReleaseVersion = (value: unknown): value is string =>
  typeof value === 'string' && releaseVersion.test(value)

export interface UsagePing {
  readonly v: 1
  readonly product: UsageProduct
  readonly version: string
  readonly os: Platform
  readonly arch: Arch
  /** The first ping this install has sent. */
  readonly first: boolean
  /** The first ping this install has sent in this ISO week, UTC. */
  readonly newWeek: boolean
  /** The first ping this install has sent in this calendar month, UTC. */
  readonly newMonth: boolean
}
const PING_KEYS = ['arch', 'first', 'newMonth', 'newWeek', 'os', 'product', 'v', 'version']

export function parseUsagePing(value: unknown): Parsed<UsagePing> {
  if (!isRecord(value)) return fail('body')
  if (Object.keys(value).sort().join() !== PING_KEYS.join()) return fail('keys')
  if (value.v !== 1) return fail('v')
  if (!oneOf(USAGE_PRODUCTS, value.product)) return fail('product')
  if (!isReleaseVersion(value.version)) return fail('version')
  if (!oneOf(PLATFORMS, value.os)) return fail('os')
  if (!oneOf(ARCHES, value.arch)) return fail('arch')
  const { first, newWeek, newMonth } = value
  if (typeof first !== 'boolean' || typeof newWeek !== 'boolean' || typeof newMonth !== 'boolean')
    return fail('flags')
  return ok({
    v: 1,
    product: value.product,
    version: value.version,
    os: value.os,
    arch: value.arch,
    first,
    newWeek,
    newMonth,
  })
}

// ------------------------------------------------------------------ Admin view

/** Per product. Week and month are calendar periods in UTC, never rolling windows. */
export interface UsageTotals {
  /** Installs that pinged on the last complete UTC day. */
  readonly day: number
  /** Installs that have pinged this ISO week so far. */
  readonly week: number
  readonly lastWeek: number
  /** Installs that have pinged this calendar month so far. */
  readonly month: number
  readonly lastMonth: number
  /** First pings: new installs that reached the server. */
  readonly new7d: number
  readonly new30d: number
}
export interface AdminSeriesDay {
  /** YYYY-MM-DD, UTC. */
  readonly day: string
  readonly desktop: number
  readonly host: number
  readonly installs: number
  readonly downloads: number
}
/** `pings` is null when fewer than three, so no small cell singles anyone out. */
export interface AdminVersionRow {
  readonly product: UsageProduct
  readonly version: string
  readonly pings: number | null
}
export interface AdminPlatformRow {
  readonly product: UsageProduct
  readonly os: Platform
  readonly arch: Arch
  readonly pings: number | null
}
export interface AdminStats {
  readonly generatedAt: string
  readonly accounts: { readonly total: number; readonly new7d: number; readonly new30d: number }
  readonly hosts: { readonly enrolled: number; readonly online: number; readonly seen24h: number }
  readonly downloads: {
    readonly last7d: number
    readonly last30d: number
    readonly total: number
    readonly byArtifact30d: readonly {
      readonly artifact: DownloadArtifact
      readonly downloads: number
    }[]
  }
  readonly usage: { readonly desktop: UsageTotals; readonly host: UsageTotals }
  /** Ascending, at most ADMIN_SERIES_DAYS entries ending today. */
  readonly series: readonly AdminSeriesDay[]
  /** Last seven days, busiest first, at most ADMIN_BREAKDOWN_ROWS. */
  readonly versions: readonly AdminVersionRow[]
  readonly platforms: readonly AdminPlatformRow[]
}
export const ADMIN_SERIES_DAYS = 90
export const ADMIN_BREAKDOWN_ROWS = 40
const MAX_COUNT = Number.MAX_SAFE_INTEGER
const count = (value: unknown): value is number => isCount(value, MAX_COUNT)
const smallCell = (value: unknown): value is number | null =>
  value === null || (count(value) && value >= 3)
const isDay = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  isIsoTime(`${value}T00:00:00.000Z`)

function counts<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!isRecord(value)) return null
  const out = {} as Record<K, number>
  for (const key of keys) {
    const item = value[key]
    if (!count(item)) return null
    out[key] = item
  }
  return out
}
function list<T>(value: unknown, max: number, item: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  const out: T[] = []
  for (const entry of value) {
    const parsed = item(entry)
    if (parsed === null) return null
    out.push(parsed)
  }
  return out
}
const TOTALS = ['day', 'week', 'lastWeek', 'month', 'lastMonth', 'new7d', 'new30d'] as const
const SERIES = ['desktop', 'host', 'installs', 'downloads'] as const

const artifactRow = (v: unknown) =>
  isRecord(v) && oneOf(DOWNLOAD_ARTIFACTS, v.artifact) && count(v.downloads)
    ? { artifact: v.artifact, downloads: v.downloads }
    : null
const seriesRow = (v: unknown): AdminSeriesDay | null => {
  const values = counts(v, SERIES)
  return values && isRecord(v) && isDay(v.day) ? { day: v.day, ...values } : null
}
const versionRow = (v: unknown): AdminVersionRow | null =>
  isRecord(v) &&
  oneOf(USAGE_PRODUCTS, v.product) &&
  isReleaseVersion(v.version) &&
  smallCell(v.pings)
    ? { product: v.product, version: v.version, pings: v.pings }
    : null
const platformRow = (v: unknown): AdminPlatformRow | null =>
  isRecord(v) &&
  oneOf(USAGE_PRODUCTS, v.product) &&
  oneOf(PLATFORMS, v.os) &&
  oneOf(ARCHES, v.arch) &&
  smallCell(v.pings)
    ? { product: v.product, os: v.os, arch: v.arch, pings: v.pings }
    : null

export function parseAdminStats(value: unknown): Parsed<AdminStats> {
  if (!isRecord(value) || !isIsoTime(value.generatedAt)) return fail('body')
  const accounts = counts(value.accounts, ['total', 'new7d', 'new30d'] as const)
  const hosts = counts(value.hosts, ['enrolled', 'online', 'seen24h'] as const)
  const downloads = counts(value.downloads, ['last7d', 'last30d', 'total'] as const)
  const byArtifact = isRecord(value.downloads)
    ? list(value.downloads.byArtifact30d, DOWNLOAD_ARTIFACTS.length, artifactRow)
    : null
  const usage = isRecord(value.usage) ? value.usage : {}
  const desktop = counts(usage.desktop, TOTALS)
  const host = counts(usage.host, TOTALS)
  const series = list(value.series, ADMIN_SERIES_DAYS, seriesRow)
  const versions = list(value.versions, ADMIN_BREAKDOWN_ROWS, versionRow)
  const platforms = list(value.platforms, ADMIN_BREAKDOWN_ROWS, platformRow)
  if (!accounts || !hosts || !downloads || !byArtifact || !desktop || !host) return fail('totals')
  if (!series || !versions || !platforms) return fail('rows')
  return ok({
    generatedAt: value.generatedAt,
    accounts,
    hosts,
    downloads: { ...downloads, byArtifact30d: byArtifact },
    usage: { desktop, host },
    series,
    versions,
    platforms,
  })
}
