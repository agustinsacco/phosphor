import { describe, expect, it } from 'vitest'
import { CONTROL_MACHINE_ROUTES, HOST_HEADERS } from '@phosphor/shared/control-api'
import {
  SELF,
  fakeControl,
  machineGrant,
  reachControl,
  sibling,
  type ControlAnswer,
} from './__fixtures__/siblings'
import { REACH_GRANT_TTL_MS, ReachGrantRefused, createReachGrants } from './grants'

const bee2 = sibling('bee2')

function setup(answer: () => ControlAnswer) {
  const clock = { now: Date.now() }
  const control = fakeControl(answer)
  const signedIn = { value: true }
  const grants = createReachGrants({
    control: () => (signedIn.value ? reachControl() : null),
    fetch: control.fetch,
    now: () => clock.now,
  })
  return { grants, calls: control.calls, clock, signedIn }
}

describe('reach grants', () => {
  it('asks control for a grant to one target, signed as this machine', async () => {
    const reply = machineGrant(bee2)
    const { grants, calls } = setup(() => ({ status: 200, body: reply }))
    const grant = await grants.grantFor(bee2.id)
    expect(grant).toMatchObject({ grant: reply.grant, host: reply.host })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: CONTROL_MACHINE_ROUTES.hostMachineGrants,
    })
    expect(JSON.parse(calls[0]!.body)).toEqual({ targetHostId: bee2.id })
    expect(calls[0]!.headers.get(HOST_HEADERS.host)).toBe(SELF.id)
  })

  it('reuses a grant until a minute before expiry and shares one request per target', async () => {
    const { grants, calls, clock } = setup(() => ({ status: 200, body: machineGrant(bee2) }))
    await Promise.all([grants.grantFor(bee2.id), grants.grantFor(bee2.id)])
    expect(calls).toHaveLength(1)
    clock.now += 239_000
    await grants.grantFor(bee2.id)
    expect(calls).toHaveLength(1)
    clock.now += 2_000
    await grants.grantFor(bee2.id)
    expect(calls).toHaveLength(2)
  })

  it('never holds a grant longer than five minutes, whatever control says', async () => {
    const { grants, calls, clock } = setup(() => ({ status: 200, body: machineGrant(bee2, 3600) }))
    const grant = await grants.grantFor(bee2.id)
    expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(clock.now + REACH_GRANT_TTL_MS)
    clock.now += REACH_GRANT_TTL_MS - 59_000
    await grants.grantFor(bee2.id)
    expect(calls).toHaveLength(2)
  })

  it('asks again after clear', async () => {
    const { grants, calls } = setup(() => ({ status: 200, body: machineGrant(bee2) }))
    await grants.grantFor(bee2.id)
    grants.clear(bee2.id)
    await grants.grantFor(bee2.id)
    expect(calls).toHaveLength(2)
  })

  it.each([
    [{ status: 403, code: 'forbidden' }, 'reach-off'],
    [{ status: 409, code: 'conflict' }, 'unavailable'],
    [{ status: 404, code: 'not-found' }, 'unknown'],
    [{ status: 410, code: 'gone' }, 'signed-out'],
    [{ status: 429, code: 'too-many-requests' }, 'too-many-requests'],
    [{ status: 503, code: 'unavailable' }, 'offline'],
    ['offline', 'offline'],
  ] as const)('reads control %j as %s and caches no refusal', async (answer, reason) => {
    const { grants, calls } = setup(() => answer)
    await expect(grants.grantFor(bee2.id)).rejects.toEqual(new ReachGrantRefused(reason))
    await expect(grants.grantFor(bee2.id)).rejects.toBeInstanceOf(ReachGrantRefused)
    expect(calls).toHaveLength(2)
  })

  it('refuses a grant for another machine than the one asked for', async () => {
    const { grants } = setup(() => ({ status: 200, body: machineGrant(sibling('bee3')) }))
    await expect(grants.grantFor(bee2.id)).rejects.toEqual(new ReachGrantRefused('unknown'))
  })

  it('refuses before enrollment without asking control', async () => {
    const { grants, calls, signedIn } = setup(() => ({ status: 200, body: machineGrant(bee2) }))
    signedIn.value = false
    await expect(grants.grantFor(bee2.id)).rejects.toEqual(new ReachGrantRefused('signed-out'))
    expect(calls).toHaveLength(0)
  })
})
