import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { newRoutine } from '@phosphor/shared/routines'
import { route } from './route'
import {
  createRemoteRoutineState,
  UNAVAILABLE,
  type Connection,
  type RemoteRoutinePorts,
} from './state'

function setup() {
  const host = randomUUID(),
    id = randomUUID()
  const repositoryId = '0123456789abcdef'
  const call = vi.fn<Connection['call']>(async () => ({
    type: 'result',
    id: randomUUID(),
    ok: true,
    data: [],
  }))
  const send = vi.fn<Connection['send']>(async () => ({
    requestId: randomUUID(),
    status: 'done',
    data: {},
  }))
  const connection: Connection = {
    snapshot: () => ({
      connectionToken: 'initial',
      state: 'ready',
      capabilities: ['routines', 'sessions.control'],
      repositories: [{ id: repositoryId, name: 'Repo label', path: '/private/host' }],
      lanes: [],
    }),
    call,
    send,
  }
  const ports: RemoteRoutinePorts = {
    connection: (h) => (h === host ? connection : undefined),
    hosts: () => [host],
    label: () => 'Host',
  }
  const raw = {
    ...newRoutine('renderer label'),
    name: 'Task',
    instructions: 'Review',
    provider: 'test',
    model: 'test',
    machine: { repositoryId },
  }
  return {
    state: createRemoteRoutineState(),
    ports,
    host,
    id,
    call,
    send,
    raw,
    machine: `host:${host}`,
    key: `host:${host}/${id}`,
  }
}

it('leaves non-routine channels and all local locations for local IPC handling', () => {
  const s = setup()
  expect(route(s.state, s.ports, 'hosts:snapshot', [s.machine])).toBeNull()
  expect(route(s.state, s.ports, 'routines:list', [])).toBeNull()
  expect(route(s.state, s.ports, 'routines:list', ['local'])).toBeNull()
  expect(route(s.state, s.ports, 'routines:save', [s.raw, 'local'])).toBeNull()
  expect(s.call).not.toHaveBeenCalled()
  expect(s.send).not.toHaveBeenCalled()
})

it('queries only the decoded machine with empty list params', async () => {
  const s = setup()
  expect(await route(s.state, s.ports, 'routines:list', [s.machine])?.result).toEqual({
    routines: [],
    runs: [],
    background: false,
    error: null,
  })
  expect(s.call).toHaveBeenCalledWith('routines.list', {})
  await expect(
    route(s.state, s.ports, 'routines:list', [`host:${randomUUID()}`])?.result,
  ).rejects.toThrow(UNAVAILABLE)
  expect(s.call).toHaveBeenCalledTimes(1)
})

it.each(['cancel', 'skipNext', 'archive', 'delete', 'pauseAll'] as const)(
  'decodes %s into exactly the machine wire fields',
  async (op) => {
    const s = setup()
    await route(s.state, s.ports, `routines:${op}`, [op === 'pauseAll' ? s.machine : s.key])?.result
    expect(s.send.mock.calls).toEqual([
      [
        op === 'pauseAll'
          ? { type: 'routine.pauseAll' }
          : op === 'cancel'
            ? { type: 'routine.cancel', runId: s.id }
            : { type: `routine.${op}`, routineId: s.id },
      ],
    ])
  },
)

it('rejects malformed targets and machine/id shape mismatches synchronously', () => {
  const s = setup()
  expect(() => route(s.state, s.ports, 'routines:list', ['host:bad'])).toThrow(UNAVAILABLE)
  expect(() => route(s.state, s.ports, 'routines:list', [s.key])).toThrow(UNAVAILABLE)
  expect(() => route(s.state, s.ports, 'routines:pauseAll', [s.key])).toThrow(UNAVAILABLE)
  expect(() => route(s.state, s.ports, 'routines:archive', [s.machine])).toThrow(UNAVAILABLE)
  expect(s.send).not.toHaveBeenCalled()
})

it('matches saved id to host and rejects non-object saves before forwarding', () => {
  const s = setup()
  for (const input of [null, [], 'bad'])
    expect(() =>
      route(s.state, s.ports, 'routines:save', [input, undefined, undefined, s.machine]),
    ).toThrow(UNAVAILABLE)
  for (const saved of [s.machine, 'local', `host:${randomUUID()}/${s.id}`])
    expect(() => route(s.state, s.ports, 'routines:save', [s.raw, saved, 1, s.machine])).toThrow(
      UNAVAILABLE,
    )
  expect(s.send).not.toHaveBeenCalled()
})

it('picks wire fields, preserves existing flags and revision, and prioritizes explicit repository id', async () => {
  const s = setup()
  s.send.mockResolvedValueOnce({
    requestId: randomUUID(),
    status: 'done',
    data: { routineId: s.id, revision: 2 },
  })
  await route(s.state, s.ports, 'routines:save', [
    {
      ...s.raw,
      repositoryId: '0123456789abcdef',
      machine: { repositoryId: 'aaaaaaaaaaaaaaaa' },
      enabled: true,
      trusted: true,
      attention: 'private metadata',
    },
    s.key,
    1,
  ])?.result
  const { workspacePath: _path, machine: _machine, ...fields } = s.raw
  expect(s.send.mock.calls).toEqual([
    [
      {
        type: 'routine.save',
        routineId: s.id,
        expectedRevision: 1,
        routine: { ...fields, enabled: true, trusted: true, repositoryId: '0123456789abcdef' },
      },
    ],
  ])
})

it('forwards history offset to validation without issuing an invalid query', async () => {
  const s = setup()
  await expect(route(s.state, s.ports, 'routines:history', [s.key, -1])?.result).rejects.toThrow(
    UNAVAILABLE,
  )
  expect(s.call).not.toHaveBeenCalled()
  await expect(route(s.state, s.ports, 'routines:history', [s.key, 12])?.result).rejects.toThrow(
    UNAVAILABLE,
  )
  expect(s.call.mock.calls).toEqual([
    ['routines.history', { routineId: s.id, offset: 12 }],
    ['routines.list', {}],
  ])
})
