import { expect, it, vi } from 'vitest'
import { verifyStartupAccount } from './session-account'

it('preserves non-strict owners and already provisioned accounts without another RPC', async () => {
  const request = vi.fn(async () => ({
    type: 'response' as const,
    command: 'get_state',
    success: false as const,
    error: 'not ready',
  }))
  await verifyStartupAccount({ request }, undefined, undefined)
  await verifyStartupAccount({ request }, true, 'account')
  expect(request).not.toHaveBeenCalled()
})

it('fails closed when pi cannot report its resolved model', async () => {
  const request = vi.fn(async () => ({
    type: 'response' as const,
    command: 'get_state',
    success: false as const,
    error: 'not ready',
  }))
  await expect(verifyStartupAccount({ request }, true, undefined)).rejects.toThrow(
    'Cannot verify the active pi account',
  )
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'get_state' })
})
