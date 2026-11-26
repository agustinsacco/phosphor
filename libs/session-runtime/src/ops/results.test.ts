import { expect, it, vi } from 'vitest'
import * as results from './results'

const text = '"😀\\'.repeat(1500)
const columns = { id: (r: { id: number }) => r.id, title: (r: { title: string }) => r.title }

it('fits quote-heavy UTF-8 rows as serialized JSON, and continues after the last delivered row', () => {
  const rows = Array.from({ length: 5 }, (_, id) => ({ id, title: text }))
  const ctx = { limit: 5 } as never
  const first = results.pageInventory(rows, ctx, columns)
  expect(first.data).toEqual(rows.slice(0, 1))
  expect(first.next).toBe('1')
  expect(Buffer.byteLength(JSON.stringify(first.data))).toBeLessThanOrEqual(12 * 1024)
  const second = results.pageInventory(rows, { page: first.next } as never, columns)
  expect(second.data).toEqual(rows.slice(1, 2))
  expect(second.next).toBe('2')
})

it('delivers one oversized row with a visible omission marker and keeps projecting compact text', () => {
  const rows = [
    { id: 0, title: `Line 1\nLine 2 ${text.repeat(15)}` },
    { id: 1, title: '' },
  ]
  const page = results.pageInventory(rows, {} as never, columns)
  expect(page.data).toEqual([{ id: 0, title: expect.stringMatching(/…\(\+\d+ chars\)$/u) }])
  expect(Buffer.byteLength(JSON.stringify(page.data))).toBeLessThanOrEqual(12 * 1024)
  expect(page.next).toBe('1')
  expect(page.text).toMatch(/^id \| title\n0 \| Line 1 Line 2 [^\n]+…$/u)
  expect(Array.from(page.text.split(' | ').at(-1)!)).toHaveLength(80)
})

it('leaves qualified refs copyable and presents UTC timestamps at minute precision', () => {
  const ref = `host:${'a'.repeat(36)}/lane:${'b'.repeat(36)}`
  const rows = [{ ref, updated: '2026-11-26T10:56:43.123Z' }]
  const page = results.pageInventory(rows, {} as never, {
    ref: (row) => row.ref,
    updated: (row) => results.rowTime(row.updated),
  })
  expect(page.text).toBe(`ref | updated\n${ref} | 2026-11-26T10:56Z`)
})

it('labels cached MCP status with the snapshot age, or says the age is unknown', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(20_000)
  try {
    expect(results.cachedMcpStatus({ name: 'docs', state: 'ready' }, 7_500)).toContain(
      'Cached status (12s old)',
    )
    expect(results.cachedMcpStatus({ name: 'docs' })).toContain('Cached status (age unknown)')
  } finally {
    now.mockRestore()
  }
})
