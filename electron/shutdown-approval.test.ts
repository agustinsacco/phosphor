import { describe, expect, it, vi } from 'vitest'
import { ShutdownApproval } from './shutdown-approval'

describe('ShutdownApproval', () => {
  it('closes admission synchronously for an idle quit', async () => {
    const confirm = vi.fn()
    const approval = new ShutdownApproval({ needsConfirmation: () => false, confirm })
    const result = approval.request('quit')
    expect(approval.closing).toBe(true)
    expect(approval.canQuit).toBe(true)
    expect(() => approval.assertCanStart()).toThrow('shutting down')
    expect(await result).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('cancellation leaves admission open and permits a later attempt', async () => {
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const approval = new ShutdownApproval({ needsConfirmation: () => true, confirm })
    expect(await approval.request('quit')).toBe(false)
    expect(approval.closing).toBe(false)
    expect(() => approval.assertCanStart()).not.toThrow()
    expect(await approval.request('quit')).toBe(true)
    expect(approval.closing).toBe(true)
  })

  it('rejects overlapping intents and duplicate clicks without another dialog', async () => {
    let answer!: (value: boolean) => void
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        }),
    )
    const approval = new ShutdownApproval({ needsConfirmation: () => true, confirm })
    const first = approval.request('update')
    expect(await approval.request('quit')).toBe(false)
    expect(await approval.request('update')).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(approval.closing).toBe(false)
    answer(true)
    expect(await first).toBe(true)
    expect(await approval.request('update')).toBe(false)
    expect(approval.canQuit).toBe(false) // No quit during an unfinished bundle swap.
    approval.allowUpdateQuit()
    expect(approval.canQuit).toBe(true)
  })

  it('reopens admission after failed update preparation, but not during teardown', async () => {
    const approval = new ShutdownApproval({ needsConfirmation: () => false, confirm: vi.fn() })
    await approval.request('update')
    approval.allowUpdateQuit()
    approval.releaseFailedUpdate()
    expect(approval.closing).toBe(false)
    expect(approval.canQuit).toBe(false)
    await approval.request('update')
    approval.allowUpdateQuit()
    approval.beginTeardown()
    approval.releaseFailedUpdate()
    expect(approval.closing).toBe(true)
  })

  it('never authorizes on confirmation failure and remains retryable', async () => {
    const confirm = vi
      .fn()
      .mockRejectedValueOnce(new Error('dialog unavailable'))
      .mockResolvedValue(false)
    const approval = new ShutdownApproval({ needsConfirmation: () => true, confirm })
    await expect(approval.request('quit')).rejects.toThrow('dialog unavailable')
    expect(approval.closing).toBe(false)
    expect(await approval.request('quit')).toBe(false)
    expect(() => approval.beginTeardown()).toThrow('not authorized')
    expect(() => approval.allowUpdateQuit()).toThrow('not authorized')
  })
})
