/**
 * How the telemetry popover says a number and draws a window of samples.
 *
 * Pure on purpose: the ranges, the unavailable word and the braille packer are
 * the parts worth pinning down, and none of them needs a store or a Host.
 * Byte sizes come from `lib/format` like every other surface's.
 */
import { formatBytes } from '@/lib/format'

/** The graph's windows. One ring backs all three; changing it never re-reads. */
export const RANGES = [
  { id: '1m', label: '1m', ms: 60_000 },
  { id: '5m', label: '5m', ms: 300_000 },
  { id: '1h', label: '1h', ms: 3_600_000 },
] as const

export type RangeId = (typeof RANGES)[number]['id']

export const rangeMs = (id: RangeId): number => RANGES.find((r) => r.id === id)!.ms

/** What a number the machine would not give looks like everywhere in the popover. */
export const UNREADABLE = '—'

export function formatPct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNREADABLE
  return `${value.toFixed(digits)}%`
}

export function formatBytesOr(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? UNREADABLE : formatBytes(bytes)
}

/**
 * How stale the sample on screen is. Past `staleMs` the number stops being an
 * age and says what it is, because "3m ago" under a stopped poll reads as a
 * measurement rather than as the last one that got through.
 */
export function sampledAgo(ageMs: number | null, staleMs: number): string {
  if (ageMs === null) return 'no sample yet'
  if (ageMs >= staleMs) return 'sample stalled'
  if (ageMs < 2_000) return 'just now'
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`
  return `${Math.floor(ageMs / 60_000)}m ago`
}

/**
 * A btop-style graph in braille: two samples per character, each of the two
 * columns four dots tall, so 40 characters hold 80 samples.
 *
 * `values` are percentages (0-100) oldest first. A window wider than the
 * resolution keeps the highest sample in each bucket, which is the honest
 * reading of a spiky series: a 90% spike that landed between two drawn columns
 * was there.
 */
export function brailleBars(values: readonly number[], columns: number): string {
  if (values.length === 0 || columns <= 0) return ''
  const slots = columns * 2
  const levels = new Array<number>(slots)
  const bucket = values.length / slots
  for (let slot = 0; slot < slots; slot++) {
    const from = Math.floor(slot * bucket)
    const to = Math.max(from + 1, Math.floor((slot + 1) * bucket))
    let peak = 0
    for (let i = from; i < to && i < values.length; i++) peak = Math.max(peak, values[i] ?? 0)
    levels[slot] = level(peak)
  }
  let out = ''
  for (let column = 0; column < columns; column++) {
    const left = levels[column * 2] ?? 0
    const right = levels[column * 2 + 1] ?? 0
    out += String.fromCharCode(BRAILLE_START + (dots(left, true) | dots(right, false)))
  }
  return out
}

/** Braille dot bit for one column of four rows, filled from the bottom up. */
function dots(level: number, left: boolean): number {
  const bits = left ? LEFT_DOTS : RIGHT_DOTS
  let mask = 0
  for (let row = 4 - level; row < 4; row++) mask |= bits[row] ?? 0
  return mask
}

/** 0% is an empty cell; anything above it claims at least one dot. */
function level(pct: number): number {
  if (pct <= 0) return 0
  return Math.max(1, Math.min(4, Math.round((pct / 100) * 4)))
}

// Dot numbering is column-major: 1,2,3,6 down the left, 4,5,7,8 down the right.
const BRAILLE_START = 0x2800
const LEFT_DOTS = [0x01, 0x02, 0x04, 0x20] as const
const RIGHT_DOTS = [0x08, 0x10, 0x40, 0x80] as const
