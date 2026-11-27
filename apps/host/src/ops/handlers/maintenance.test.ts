import { expect, it, vi } from 'vitest'
import type { DaemonHandlerDeps } from './index'
import { domainHandlers } from './index'

it('previews a named bounded cleanup plan and refuses a stale plan before mutation', async () => {
  const candidate = {
    kind: 'sandbox',
    path: '/sandbox',
    bytes: 0,
    reason: 'empty',
    identity: 'fixture',
  }
  let rows = [candidate]
  const apply = vi.fn(async () => ({ removed: 1 }))
  const handlers = domainHandlers({
    sandboxes: { cleanup: { inspect: async () => ({ rows, skipped: {} }), apply } },
  } as unknown as DaemonHandlerDeps)
  const ctx = { principal: { kind: 'local' }, signal: new AbortController().signal } as never
  const page = await handlers['maintenance.scan']!({}, ctx)
  expect(page.data).toMatchObject({ plan: expect.any(String), candidates: [candidate] })
  const { plan } = page.data as { plan: string }
  expect(apply).not.toHaveBeenCalled()
  rows = [{ ...candidate, identity: 'replaced' }]
  await expect(handlers['maintenance.run']!({ plan }, ctx)).rejects.toThrow('stale')
  expect(apply).not.toHaveBeenCalled()
})
