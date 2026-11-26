import { createHash } from 'node:crypto'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { OPS_LIMITS, type OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { Judged, Refusal } from './judge'
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

const CURSOR = /^h1_([0-9a-f]{24})_(.+)$/
const cursorHost = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 24)

export function cursorForHost(
  page: string | undefined,
  hostId: string,
): string | Refusal | undefined {
  if (page === undefined) return undefined
  const match = CURSOR.exec(page)
  if (!match) return page
  return match[1] === cursorHost(hostId)
    ? match[2]!
    : { code: 'bad-request', text: 'This page belongs to another host. Continue with its --host.' }
}

export function hasHostCursor(page: string | undefined): boolean {
  return page !== undefined && CURSOR.test(page)
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
  const hostDataShare = Math.floor(OPS_LIMITS.callDataBytes / total)
  const rows = hosts.map((host, i) => batchRow(host, results[i]!, share, hostDataShare))
  const text = prefix + rows.map(({ header, row }) => `${header}\n${row.text}`).join('\n')
  const data = { summary: { total, ok, failed }, hosts: rows.map(({ row }) => row) }
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
  const row = {
    hostId: host.id,
    label: host.label,
    status,
    ...(status === 'denied' ? { code: result.code } : {}),
    text: clipBytes(
      status === 'confirm' ? result.title : result.text,
      share - Buffer.byteLength(header) - 1,
    ),
    ...(status === 'ok' && result.next !== undefined
      ? { next: `h1_${cursorHost(host.id)}_${result.next}` }
      : {}),
    ...(status !== 'confirm' && result.data !== undefined ? { data: result.data } : {}),
  }
  if (Buffer.byteLength(JSON.stringify(row)) > dataShare - 128)
    row.data = {
      omitted: true,
      reason: `Data from ${label} was too large. Query it with --host ${JSON.stringify(label)}.`,
    }
  return { header, row }
}
