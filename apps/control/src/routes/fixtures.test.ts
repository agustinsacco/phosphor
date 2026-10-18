import { expect, it, vi } from 'vitest'
import { CONTROL_ROUTES as R } from '@phosphor/shared/control-api'
import { userId } from '../test-support'
import { date, setup } from './__fixtures__/fixtures'

it('creates fresh dependencies, signing identities and mocks for each route harness', async () => {
  const first = setup()
  const second = setup()
  expect(first.deps).not.toBe(second.deps)
  expect(first.app).not.toBe(second.app)
  expect(first.key.publicKey).not.toBe(second.key.publicKey)
  expect(first.results.control_host_key).toEqual({
    outcome: 'active',
    publicKey: first.key.publicKey,
  })
  expect(second.results.control_host_key).toEqual({
    outcome: 'active',
    publicKey: second.key.publicKey,
  })
  expect(first.deps.nonces.key).not.toBe(second.deps.nonces.key)
  expect(first.deps.nonces.host).not.toBe(second.deps.nonces.host)
  first.results.control_machines = { machines: [], serverTime: date }
  expect((await first.call(R.machines, 'GET')).status).toBe(200)
  expect(first.deps.log).toHaveBeenCalled()
  expect(first.deps.supabase.getUser).toHaveBeenCalled()
  expect(second.deps.log).not.toHaveBeenCalled()
  expect(second.deps.supabase.getUser).not.toHaveBeenCalled()
  expect(second.deps.supabase.rpc).not.toHaveBeenCalled()
})

it('isolates mutable RPC results between route harnesses', async () => {
  const first = setup()
  const second = setup()
  expect(first.results).not.toBe(second.results)
  expect(first.results.control_account).not.toBe(second.results.control_account)
  first.results.control_account = { enabled: false, maxHosts: 20 }
  second.results.control_machines = { machines: [], serverTime: date }
  expect((await first.call(R.machines, 'GET')).status).toBe(403)
  const response = await second.call(R.machines, 'GET')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ machines: [], serverTime: date })
  expect(vi.mocked(first.deps.supabase.rpc).mock.calls.map(([name]) => name)).toEqual([
    'control_account',
  ])
})

it('advances only its own clock and rate limits with freshly signed requests', async () => {
  const first = setup()
  const second = setup()
  const start = second.deps.clock()
  first.results.control_enrollment_poll = second.results.control_enrollment_poll = {
    outcome: 'pending',
  }
  const poll = (h: ReturnType<typeof setup>) =>
    h.call(R.enrollmentPoll, 'POST', { enrollmentId: userId }, 'key')
  expect((await poll(first)).status).toBe(200)
  expect((await poll(first)).status).toBe(429)
  expect((await poll(second)).status).toBe(200)
  first.advance(2000)
  expect(first.deps.clock()).toBe(start + 2000)
  expect(second.deps.clock()).toBe(start)
  expect((await poll(first)).status).toBe(200)
  expect((await poll(second)).status).toBe(429)
  second.advance(2000)
  expect((await poll(second)).status).toBe(200)
})
