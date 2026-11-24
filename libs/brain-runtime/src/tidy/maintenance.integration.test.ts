import { expect, it, vi } from 'vitest'
import { savedRead, realService } from './__fixtures__/real-service'

it('the service sweeps what an approval of 140 memories deferred, and folds the repeat there', async () => {
  const s = await realService()
  const summaries = Array.from({ length: 138 }, (_, i) => `Harbor change ${i} shipped.`)
  // Rows 139 and 140: beyond the 128 the approval sweeps itself, so only the driver can fold them.
  summaries.push('Rina leads Ledger.', 'Rina leads Ledger.')
  const status = await savedRead(s.store, s.service, s.options, summaries)
  expect(status.counts.entities).toBe(2)
  await vi.waitFor(async () => expect((await s.service.api.status()).tidy.automaticFolds).toBe(1))
  expect((await s.service.api.status()).counts.memories).toBe(139)
  expect(s.store.takeTidyMaintenance()).toEqual([])
})
