import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { OPS_LIMITS, type OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { Judged } from './judge'
import type { RoutedHost } from './ports'

/** Cuts text to `bytes` UTF-8 bytes without splitting a code point. */
export function clipBytes(text: string, bytes: number): string {
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.length <= bytes) return text
  const marker = ' […cut]'
  let end = bytes - Buffer.byteLength(marker)
  if (end < 0) return ''
  while ((encoded[end]! & 0xc0) === 0x80) end--
  return encoded.toString('utf8', 0, end) + marker
}

/** A v1 batch lives in the result envelope's data, ordered as requested. */
export function batchResult(
  j: Judged,
  hosts: readonly RoutedHost[],
  results: readonly OpsRunResult[],
  batch: boolean,
): OpsRunResult {
  if (!batch) return results[0]!
  const total = hosts.length
  const ok = results.filter((r) => r.status === 'ok').length
  const failed = total - ok
  const prefix = failed > 0 && ok > 0 ? `${failed} of ${total} hosts failed\n` : ''
  const textBudget = ok === 0 ? HOST_LIMITS.messageChars : OPS_LIMITS.resultBytes
  const share = Math.floor((textBudget - Buffer.byteLength(prefix)) / total) - 1
  const summary = { total, ok, failed }
  const overhead = jsonBytes({ summary, hosts: [] }) + total - 1
  const hostDataShare = Math.floor((OPS_LIMITS.callDataBytes - overhead) / total)
  const rows = hosts.map((host, i) => batchRow(host, results[i]!, share, hostDataShare))
  const text =
    prefix + rows.map(({ header, row, hint }) => `${header}\n${row.text}${hint}`).join('\n')
  const data = { summary, hosts: rows.map(({ row }) => row) }
  const first = results[0]
  return ok === 0
    ? {
        status: 'denied',
        code: first?.status === 'denied' ? first.code : 'unavailable',
        text,
        data,
      }
    : { status: 'ok', applies: j.spec.applies, text, data }
}

function batchRow(host: RoutedHost, result: OpsRunResult, share: number, dataShare: number) {
  const label = host.label.replace(/\s+/g, ' ')
  const status = result.status
  const header = `== ${clipBytes(label, share - 22)} (${status})`
  const bodyBytes = share - Buffer.byteLength(header) - 1
  const next = status === 'ok' ? result.next : undefined
  const hint = next === undefined ? '' : pageHint(host.label, next, bodyBytes)
  const row = {
    hostId: host.id,
    label: host.label,
    status,
    ...(status === 'denied' ? { code: result.code } : {}),
    text: clipBytes(
      status === 'confirm' ? result.title : result.text,
      bodyBytes - Buffer.byteLength(hint),
    ),
    ...(next !== undefined ? { next } : {}),
    ...(status !== 'confirm' && result.data !== undefined ? { data: result.data } : {}),
  }
  if (jsonBytes(row) > dataShare)
    row.data = {
      omitted: true,
      reason: `Data from ${label} was too large. Query it with --host ${flagValue(host.label)}.`,
    }
  return { header, row, hint }
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

// These hints also appear in bash; double quotes alone would expand $ and backticks.
const flagValue = (value: string) => JSON.stringify(value).replace(/[$`]/g, '\\$&')

function pageHint(label: string, next: string, bytes: number): string {
  const exact = `\nContinue: --host ${flagValue(label)} --page ${flagValue(next)}`
  if (Buffer.byteLength(exact) <= bytes / 2) return exact
  return '\nContinue: --host <label> --page <next> (see --json).'
}
