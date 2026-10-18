/** Byte, record, id and branch guards shared by the client and Host frame parsers. */
import { normalizeLabel, type Parsed } from '../control-api'
import type { StreamCursor } from './lanes'

/** Counts UTF-8 bytes, including replacement characters for unpaired surrogates. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) bytes++
    else if (c < 0x800) bytes += 2
    else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

export function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
export function text(v: unknown, max: number, min = 1): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max
}
export function member<T extends string>(v: unknown, choices: readonly T[]): v is T {
  return typeof v === 'string' && choices.some((c) => c === v)
}
export function integer(v: unknown, min = 0): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min
}
export function hex(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{16}$/.test(v)
}
export function frameId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
}
export function label(v: unknown): v is string {
  return typeof v === 'string' && normalizeLabel(v) === v
}
export function cursor(v: unknown, min = 0): StreamCursor | null {
  return record(v) && hex(v.epoch) && integer(v.seq, min) ? { epoch: v.epoch, seq: v.seq } : null
}
export function readJson(s: string, limit: number): Parsed<Record<string, unknown>> {
  if (utf8Length(s) > limit) return { ok: false, reason: 'frame-size' }
  try {
    const v: unknown = JSON.parse(s)
    return record(v) ? { ok: true, value: v } : { ok: false, reason: 'object' }
  } catch {
    return { ok: false, reason: 'json' }
  }
}

/** Wire guard for a git branch. Non-ASCII is refused; git checks it again on the Host. */
export function isLaneBranchName(v: unknown): v is string {
  return (
    text(v, 200) &&
    /^[!-~]+$/.test(v) &&
    !/[~^:?*[\\]/.test(v) &&
    !v.includes('..') &&
    !v.includes('@{') &&
    v !== '@' &&
    !v.startsWith('-') &&
    !v.startsWith('/') &&
    !v.endsWith('/') &&
    !v.includes('//') &&
    !v.endsWith('.') &&
    v.split('/').every((s) => !s.startsWith('.') && !s.endsWith('.lock'))
  )
}
