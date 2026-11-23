import { expect, expectTypeOf, it } from 'vitest'
import { OwnerLockBusy, type OwnerLockRecord } from './types'

const record: OwnerLockRecord = {
  version: 1,
  owner: 'daemon',
  pid: 4242,
  processStart: 'Sun Nov 22 22:00:00 2026',
  token: 'token',
  startedAt: '2026-11-22T22:00:00.000Z',
  program: 'phosphor',
}

it('carries the live holder and names it', () => {
  const error = new OwnerLockBusy(record)
  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe('OwnerLockBusy')
  expect(error.holder).toBe(record)
  expect(error.message).toBe("The daemon (pid 4242) runs this machine's lanes.")
  expectTypeOf<OwnerLockRecord['owner']>().toEqualTypeOf<'desktop' | 'daemon'>()
})
