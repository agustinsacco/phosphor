import { expect, it } from 'vitest'
import { parseOpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { OpRunContext } from '@phosphor/session-runtime/ops/ports'
import { contentPage } from './artifacts'

it.each(['agent', 'surface'])(
  'reassembles %s content through bounded Unicode-safe pages',
  (kind) => {
    const text = ('🦊"<&\n' + 'z'.repeat(49)).repeat(kind === 'surface' ? 23000 : 490)
    let next: string | undefined,
      all = '',
      pages = 0
    do {
      const ctx = { principal: { kind }, page: next } as OpRunContext
      const page = contentPage(text, { version: 1 }, ctx)
      expect(parseOpsRunResult({ ...page, status: 'ok', applies: 'now' })).not.toBeNull()
      expect(Buffer.byteLength(JSON.stringify(page.data))).toBeLessThanOrEqual(
        kind === 'agent' ? 16 * 1024 : 1024 * 1024,
      )
      expect(page.data.content).not.toMatch(/[\uD800-\uDBFF]$/)
      all += page.data.content
      next = page.next
      pages++
    } while (next)
    expect(pages).toBeGreaterThan(1)
    expect(all).toEqual(text)
  },
)
