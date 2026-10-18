import { expect, it } from 'vitest'
import { parseWebClientsResponse } from './web-auth'
it('returns only bounded validated device fields', () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000001',
    label: 'Phone',
    kind: 'web',
    revokedAt: null,
  }
  expect(parseWebClientsResponse({ clients: [{ ...row, accessToken: 'discard' }] })).toEqual({
    ok: true,
    value: { clients: [row] },
  })
  for (const value of [
    null,
    { clients: [null] },
    { clients: [{ ...row, kind: 'unknown' }] },
    { clients: [{ ...row, revokedAt: 'invalid' }] },
    { clients: [row, row] },
    { clients: Array.from({ length: 101 }, () => row) },
  ])
    expect(parseWebClientsResponse(value).ok).toBe(false)
})
