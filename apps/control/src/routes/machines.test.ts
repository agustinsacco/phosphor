import { expect, it, vi } from 'vitest'
import {
  CONTROL_ROUTES as R,
  machineReachRoute,
  parseEnrollmentApproveResponse,
  parseMachineReachResponse,
  parseMachinesResponse,
} from '@phosphor/shared/control-api'
import { userId } from '../test-support'
import { date, machine, setup, routeContracts } from './__fixtures__/fixtures'

const routes = [
  {
    path: R.machines,
    method: 'GET',
    mode: 'user',
    rpc: 'control_machines',
    value: undefined,
    answer: { machines: [machine], serverTime: date },
    parser: parseMachinesResponse,
    outcomes: {},
  },
  {
    path: R.machines + '/' + userId,
    method: 'PATCH',
    mode: 'user',
    rpc: 'control_machine_rename',
    value: { label: ' bee ' },
    answer: { outcome: 'renamed', machine },
    parser: parseEnrollmentApproveResponse,
    outcomes: { 'not-found': 404 },
  },
  {
    path: R.machines + '/' + userId,
    method: 'DELETE',
    mode: 'user',
    rpc: 'control_machine_revoke',
    value: undefined,
    answer: { outcome: 'revoked' },
    parser: null,
    outcomes: { 'not-found': 404 },
  },
  {
    path: machineReachRoute(userId),
    method: 'PATCH',
    mode: 'user',
    rpc: 'control_machine_reach_set',
    value: { enabled: false },
    answer: { outcome: 'set', machineReach: false },
    parser: parseMachineReachResponse,
    outcomes: { 'not-found': 404 },
    allow: 'PATCH',
  },
] as const
routeContracts(routes)

it('rejects invalid machine route ids', async () => {
  const s = setup()
  for (const method of ['PATCH', 'DELETE'])
    expect(
      (await s.call(R.machines + '/bad', method, method === 'PATCH' ? { label: 'x' } : undefined))
        .status,
    ).toBe(400)
})

it('switches reach with the caller as owner and logs the change', async () => {
  const s = setup()
  s.results.control_machine_reach_set = { outcome: 'set', machineReach: true }
  const res = await s.call(machineReachRoute(userId), 'PATCH', { enabled: true })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ machineReach: true })
  expect(s.deps.supabase.rpc).toHaveBeenCalledWith('control_machine_reach_set', {
    p_user: userId,
    p_host: userId,
    p_enabled: true,
  })
  expect(s.deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'machine.reach', hostId: userId, machineReach: true }),
  )
  for (const value of [{}, { enabled: 'false' }, { enabled: null }])
    expect((await s.call(machineReachRoute(userId), 'PATCH', value)).status).toBe(400)
  expect((await s.call(machineReachRoute('bad'), 'PATCH', { enabled: true })).status).toBe(400)
})

it('adds reach fields to the machine list from the reach lookup', async () => {
  const s = setup()
  s.results.control_machines = { machines: [machine], serverTime: date }
  s.results.control_machine_reach_list = [{ id: userId, machineReach: false, machineGrants: true }]
  const res = await s.call(R.machines, 'GET')
  expect(await res.json()).toEqual({
    machines: [{ ...machine, machineReach: false, machineGrants: true }],
    serverTime: date,
  })
  expect(s.deps.supabase.rpc).toHaveBeenCalledWith('control_machine_reach_list', {
    p_user: userId,
  })
})

it('lists machines without reach fields when the reach lookup fails', async () => {
  for (const failure of [undefined, [{ id: userId }], 'throw']) {
    const s = setup()
    s.results.control_machines = { machines: [machine], serverTime: date }
    vi.mocked(s.deps.supabase.rpc).mockImplementation(async (name) => {
      if (name !== 'control_machine_reach_list') return s.results[name]
      if (failure === 'throw') throw new Error('down')
      return failure
    })
    const res = await s.call(R.machines, 'GET')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ machines: [machine], serverTime: date })
    expect(s.deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'machines.reach_unavailable', userId }),
    )
  }
})
