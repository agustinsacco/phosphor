import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { CONTROL_MACHINE_ROUTES as M, parseHeartbeatResponse } from '@phosphor/shared/control-api'
import { userId } from '../test-support'
import { beat, machineSetup } from './__fixtures__/machine-fixtures'
import { mergeRevocations, parseMachineBeat } from './heartbeat'

const ids = (count: number) => Array.from({ length: count }, () => randomUUID())

it('keeps a beat accepted with v1 revocations when control_machine_beat throws', async () => {
  const s = machineSetup()
  const clients = ids(2)
  s.results.control_host_revocations = {
    epoch: 2,
    ownerId: userId,
    revoked: { sessions: [], clients },
  }
  vi.mocked(s.deps.supabase.rpc).mockImplementation(async (name) => {
    if (name === 'control_machine_beat') throw new Error(s.seed)
    return s.results[name]
  })
  const res = await s.heartbeat({ ...beat, machineGrants: true })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    accepted: true,
    nextInSec: 30,
    epoch: 2,
    ownerId: userId,
    revoked: { sessions: [], clients },
  })
  expect(s.deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'heartbeat.machine_unavailable', hostId: s.callerId }),
  )
  expect(JSON.stringify(vi.mocked(s.deps.log).mock.calls)).not.toContain(s.seed)
})

it('omits the machine fields when the machine beat answers something unusable', async () => {
  for (const answer of [
    undefined,
    { outcome: 'gone' },
    { outcome: 'ok', machineReach: 'yes', revoked: [] },
    { outcome: 'ok', machineReach: true, revoked: ['not-a-uuid'] },
    { outcome: 'ok', machineReach: true, revoked: ids(41) },
  ]) {
    const s = machineSetup()
    s.results.control_machine_beat = answer
    const res = await s.heartbeat()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      accepted: true,
      nextInSec: 30,
      epoch: 2,
      ownerId: userId,
      revoked: { sessions: [], clients: [] },
    })
  }
})

it('passes the Host-reported machineGrants, or null when the Host sent none', async () => {
  const s = machineSetup()
  expect((await s.heartbeat({ ...beat, machineGrants: true })).status).toBe(200)
  expect(s.deps.supabase.rpc).toHaveBeenCalledWith('control_machine_beat', {
    p_host: s.callerId,
    p_machine_grants: true,
  })
  expect((await s.heartbeat({ ...beat, seq: 2 })).status).toBe(200)
  expect(s.deps.supabase.rpc).toHaveBeenLastCalledWith('control_machine_beat', {
    p_host: s.callerId,
    p_machine_grants: null,
  })
})

it('merges principal ids after client ids and answers machineReach', async () => {
  const s = machineSetup()
  const [client, principal] = ids(2)
  s.results.control_host_revocations = {
    epoch: 2,
    ownerId: userId,
    revoked: { sessions: [], clients: [client] },
  }
  s.results.control_machine_beat = { outcome: 'ok', machineReach: false, revoked: [principal] }
  const res = await s.heartbeat()
  expect(parseHeartbeatResponse(await res.json())).toEqual({
    ok: true,
    value: {
      accepted: true,
      nextInSec: 30,
      epoch: 2,
      ownerId: userId,
      revoked: { sessions: [], clients: [client, principal] },
      machineReach: false,
    },
  })
})

it('sends principal revocations alone when only the machine beat answered', async () => {
  const s = machineSetup()
  const principals = ids(3)
  s.results.control_host_revocations = null
  s.results.control_machine_beat = { outcome: 'ok', machineReach: true, revoked: principals }
  const res = await s.heartbeat()
  expect(await res.json()).toEqual({
    accepted: true,
    nextInSec: 30,
    revoked: { sessions: [], clients: principals },
    machineReach: true,
  })
})

it('truncates 100 clients plus 40 principals to 100, keeping every client', () => {
  const clients = ids(100)
  const sessions = ids(3)
  const merged = mergeRevocations(
    { epoch: 2, ownerId: userId, revoked: { sessions, clients } },
    { machineReach: true, revoked: ids(40) },
  )
  expect(merged.revoked).toEqual({ sessions, clients })
  const some = ids(60)
  const principals = ids(40)
  const partial = mergeRevocations(
    { epoch: 2, ownerId: userId, revoked: { sessions: [], clients: some } },
    { machineReach: true, revoked: principals },
  )
  expect(partial.revoked?.clients).toEqual([...some, ...principals])
  expect(mergeRevocations(undefined, undefined)).toEqual({})
})

it('reads a machine beat strictly', () => {
  const revoked = ids(40)
  expect(parseMachineBeat({ outcome: 'ok', machineReach: true, revoked })).toEqual({
    machineReach: true,
    revoked,
  })
  for (const value of [null, [], { outcome: 'ok', machineReach: true }, { outcome: 'gone' }])
    expect(parseMachineBeat(value)).toBeNull()
})

it('leaves heartbeats their own per-IP budget while machine routes from that IP are limited', async () => {
  const s = machineSetup()
  // Directory calls spend machine-auth:<ip> until it is exhausted, never host-auth:<ip>.
  for (let i = 0; i < 30; i++) expect((await s.signed('GET', M.hostMachines)).status).toBe(200)
  expect((await s.signed('GET', M.hostMachines)).status).toBe(429)
  for (let i = 0; i < 60; i++)
    expect((await s.signed('POST', M.hostMachineGrants, { targetHostId: s.targetId })).status).toBe(
      200,
    )
  for (let i = 0; i < 29; i++)
    expect((await s.signed('POST', M.hostMachineGrants, { targetHostId: s.targetId })).status).toBe(
      429,
    )
  expect((await s.signed('GET', M.hostMachines)).status).toBe(429)
  expect((await s.heartbeat()).status).toBe(200)
})
