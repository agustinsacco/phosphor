import { expect, it, vi } from 'vitest'
import { createBrainScope, StaleBrainScope } from './brainScope'

it('discards a pending Harbor result and a deferred confirmation after Ledger replaces it', async () => {
  const target = { hostId: 'harbor', connectionToken: 'harbor-1' }
  const harbor = createBrainScope(target, () => true)
  const detach = harbor.attach()
  harbor.changeGeneration('same-generation')
  const confirmation = harbor.capture()
  let finish: (result: string) => void = () => {}
  const send = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve
      }),
  )
  const pending = harbor.run(send)
  detach()
  const ledger = createBrainScope({ hostId: 'ledger', connectionToken: 'ledger-1' }, () => true)
  ledger.attach()
  ledger.changeGeneration('same-generation')
  finish('Harbor')
  await expect(pending).rejects.toBeInstanceOf(StaleBrainScope)
  expect(confirmation()).toBe(false)
  expect(send).toHaveBeenCalledExactlyOnceWith(target)
  await expect(ledger.run(async (target) => target.hostId)).resolves.toBe('ledger')
})

it('invalidates old scopes even if the same connection is reattached', async () => {
  const scope = createBrainScope({ hostId: 'harbor', connectionToken: 'harbor-1' }, () => true)
  const detach = scope.attach()
  const old = scope.capture()
  detach()
  scope.attach()
  expect(old()).toBe(false)
  const beforeReset = scope.capture()
  scope.changeGeneration('new-generation')
  expect(beforeReset()).toBe(false)
})
