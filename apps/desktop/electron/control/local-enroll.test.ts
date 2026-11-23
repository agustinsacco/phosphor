import { expect, it, vi } from 'vitest'
import { syncLocalEnrollment } from './local-enroll'

function fixture() {
  const offer = {
    userCode: 'BCDFGHJK',
    fingerprint: '0123 4567 89ab cdef',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  const status = { machineId: 'mac', mode: 'local', enrolled: null, ownerLock: { standby: false } }
  const call = vi.fn(async (method: string) => ({
    type: 'result' as const,
    id: 'ok',
    ok: true as const,
    data: method === 'machine.local' ? status : offer,
  }))
  const lookupEnrollment = vi.fn(async () => ({
    ok: true as const,
    hostname: 'my-mac',
    keyFingerprint: offer.fingerprint,
    expiresAt: offer.expiresAt,
  }))
  const approveEnrollment = vi.fn(async () => ({
    ok: true as const,
    machine: { id: 'enrolled-id', keyFingerprint: offer.fingerprint },
  }))
  const machines = vi.fn(async () => ({ ok: true as const, machines: [] }))
  const p = {
    hostId: 'mac',
    call,
    control: { lookupEnrollment, approveEnrollment, machines },
    current: vi.fn(() => true),
    user: 'a',
    directory: vi.fn(),
    remember: vi.fn(),
    notice: vi.fn(),
    attempt: true,
  }
  return { p, status, offer, lookupEnrollment, approveEnrollment, call }
}
it('compares the local offer with signed-in lookup before approving; holds directory admission meanwhile', async () => {
  const t = fixture()
  await syncLocalEnrollment(t.p)
  expect(t.call.mock.calls).toEqual([
    ['machine.local', undefined],
    ['machine.enroll', { action: 'begin' }],
  ])
  expect(t.lookupEnrollment).toHaveBeenCalledWith(t.offer.userCode)
  expect(t.approveEnrollment).toHaveBeenCalledWith(t.offer.userCode, 'my-mac')
  expect(t.p.directory.mock.calls).toEqual([[undefined], ['enrolled-id']])
})
it('never approves a mismatched fingerprint', async () => {
  const t = fixture()
  t.lookupEnrollment.mockResolvedValue({
    ...(await t.lookupEnrollment()),
    keyFingerprint: 'different',
  })
  await syncLocalEnrollment(t.p)
  expect(t.approveEnrollment).not.toHaveBeenCalled()
  expect(t.p.notice).toHaveBeenCalledOnce()
})
it('abandons a lookup if the signed-in account or owner socket changed', async () => {
  const t = fixture()
  const found = await t.lookupEnrollment()
  t.lookupEnrollment.mockImplementation(async () => {
    t.p.current.mockReturnValue(false)
    return found
  })
  await syncLocalEnrollment(t.p)
  expect(t.approveEnrollment).not.toHaveBeenCalled()
})
it('a host limit conflict leaves the local service alone and shows a notice', async () => {
  const t = fixture()
  const approveEnrollment = vi.fn(async () => ({ ok: false as const, error: { code: 'conflict' } }))
  await syncLocalEnrollment({ ...t.p, control: { ...t.p.control, approveEnrollment } })
  expect(t.p.notice).toHaveBeenCalledWith(expect.stringMatching(/limit/i))
  expect(t.call.mock.calls.map(([method]) => method)).toEqual(['machine.local', 'machine.enroll'])
})
it('never re-enrolls an already enrolled daemon absent from this account’s directory', async () => {
  const t = fixture()
  Object.assign(t.status, { mode: 'enrolled', enrolled: { hostId: 'a-host', ownerLogin: null } })
  await syncLocalEnrollment(t.p)
  expect(t.call).toHaveBeenCalledTimes(1)
  expect(t.p.directory).toHaveBeenCalledWith('a-host')
  expect(t.p.notice).toHaveBeenCalledWith(expect.stringMatching(/another account/i))
})
it('in standby or signed out, reads identity only', async () => {
  for (const signedOut of [true, false]) {
    const t = fixture()
    t.status.ownerLock.standby = !signedOut
    await syncLocalEnrollment({ ...t.p, user: signedOut ? null : 'a' })
    expect(t.call).toHaveBeenCalledTimes(1)
    expect(t.lookupEnrollment).not.toHaveBeenCalled()
  }
})
