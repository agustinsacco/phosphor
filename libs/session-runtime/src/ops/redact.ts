/**
 * What agent control may keep about an op's arguments: the audit row's
 * `args_summary`, and whether an undo payload can be stored at all. Built from
 * the catalog spec, applied in this order:
 * - an MCP server config keeps its transport and URL host only, never headers,
 *   env, command, args or anything else;
 * - free text (`prompt`, `content`, `instructions`) keeps its first 200
 *   characters plus a SHA-256 of the whole text;
 * - every other `sensitive` arg, and any key named like a credential at any
 *   depth, becomes `"[redacted]"`.
 * The summary also shortens other long strings and is cut at 2 KiB; that is
 * size, not redaction, so it does not stop an undo payload being stored.
 * Living contract: docs/agent-control.md.
 */
import { createHash } from 'node:crypto'
import type { OpSpec } from '@phosphor/shared/ops'

export const REDACTED = '[redacted]'
export const REDACT_LIMITS = {
  /** Characters kept from a free-text argument. */
  freeTextChars: 200,
  /** Characters kept from any other string. */
  stringChars: 200,
  /** UTF-8 bytes of a stored `args_summary`. */
  summaryBytes: 2048,
} as const

const FREE_TEXT_KEYS: ReadonlySet<string> = new Set(['prompt', 'content', 'instructions'])
const CREDENTIAL_KEY =
  /^(authorization|cookie|password|passphrase|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret)$|(token|secret|password)$/i

type Spec = Pick<OpSpec, 'name' | 'sensitive'>

/** JSON with object keys sorted, so equal values serialize (and hash) the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The first `max` characters by code point, so a surrogate pair is never split. */
function head(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

export interface FreeTextDigest {
  readonly preview: string
  readonly sha256: string
  readonly chars: number
}
export function freeText(text: string): FreeTextDigest {
  return {
    preview: head(text, REDACT_LIMITS.freeTextChars),
    sha256: sha256Hex(text),
    chars: Array.from(text).length,
  }
}

/** Transport and URL host only. A URL's credentials, path and query are dropped. */
export function mcpConfigSummary(config: unknown): { transport: string; host?: string } {
  const c = config !== null && typeof config === 'object' ? (config as Record<string, unknown>) : {}
  const url = typeof c.url === 'string' ? c.url : undefined
  const transport =
    typeof c.type === 'string' ? c.type : url ? 'http' : c.command !== undefined ? 'stdio' : '?'
  let host: string | undefined
  try {
    host = url ? new URL(url).host || undefined : undefined
  } catch {
    host = undefined
  }
  return host ? { transport, host } : { transport }
}

function isMcpConfig(spec: Spec, key: string): boolean {
  return key === 'config' && spec.name.startsWith('mcp.')
}

function redactNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNested)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_KEY.test(key)) out[key] = REDACTED
      else if (FREE_TEXT_KEYS.has(key) && typeof v === 'string') out[key] = freeText(v)
      else out[key] = redactNested(v)
    }
    return out
  }
  return value
}

function shorten(value: unknown): unknown {
  if (typeof value === 'string') {
    const kept = head(value, REDACT_LIMITS.stringChars)
    return kept === value ? value : `${kept}…`
  }
  if (Array.isArray(value)) return value.map(shorten)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shorten(v)]),
    )
  return value
}

/** The args as agent control may keep them. Pure; the input is not changed. */
export function redactArgs(spec: Spec, args: Readonly<Record<string, unknown>>): unknown {
  const sensitive = new Set<string>(spec.sensitive ?? [])
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue
    if (isMcpConfig(spec, key)) out[key] = mcpConfigSummary(value)
    else if (FREE_TEXT_KEYS.has(key) && typeof value === 'string') out[key] = freeText(value)
    else if (sensitive.has(key) || CREDENTIAL_KEY.test(key)) out[key] = REDACTED
    else out[key] = redactNested(value)
  }
  return out
}

/** Cut on a code point at most `bytes` UTF-8 bytes long, marked with an ellipsis. */
function cutUtf8(text: string, bytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= bytes) return text
  let out = ''
  let used = Buffer.byteLength('…', 'utf8')
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (used + size > bytes) break
    out += ch
    used += size
  }
  return `${out}…`
}

/** The audit row's `args_summary`: redacted canonical JSON, at most 2 KiB. */
export function argsSummary(spec: Spec, args: Readonly<Record<string, unknown>>): string {
  return cutUtf8(canonicalJson(shorten(redactArgs(spec, args))), REDACT_LIMITS.summaryBytes)
}

/** True when redaction keeps every byte of `args`: only then may they be stored for replay. */
export function redactsNothing(spec: Spec, args: Readonly<Record<string, unknown>>): boolean {
  return canonicalJson(redactArgs(spec, args)) === canonicalJson(args)
}
