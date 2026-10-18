import { expect, it } from 'vitest'
import {
  CONTROL_ROUTES as R,
  parseEnrollmentApproveResponse,
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
