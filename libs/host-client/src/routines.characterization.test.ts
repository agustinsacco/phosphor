import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { newRoutine, type RoutineRun, type RoutinesSnapshot } from '@phosphor/shared/routines'
import type { RemoteRoutine } from '@phosphor/shared/host-protocol-routines'
import type { IpcInvokeChannel } from '@phosphor/shared/ipc'
import type { createHostConnection, CommandResult, HostConnectionSnapshot } from './connection'
import { createRemoteRoutines, ROUTINE_UNKNOWN } from './routines'

type Connection = Pick<ReturnType<typeof createHostConnection>, 'snapshot' | 'call' | 'send'>
function setup() {
  const host = randomUUID(),
    id = randomUUID(),
    runId = randomUUID()
  const repositoryId = '0123456789abcdef'
  const { workspacePath: _path, ...input } = newRoutine('repository')
  const row: RemoteRoutine = {
    ...input,
    name: 'Remote task',
    instructions: 'Review',
    provider: 'test',
    model: 'model',
    repositoryId,
    id,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    nextAt: null,
    archived: false,
  }
  const view: HostConnectionSnapshot = {
    connectionToken: 'test-connection-1',
    state: 'ready',
    capabilities: ['routines', 'sessions.control'],
    repositories: [{ id: repositoryId, name: 'Repo label', path: '/private/host/repo' }],
    lanes: [],
  }
  let data: unknown = [row]
  let history: unknown = [
    { id: runId, routineId: id, status: 'queued', scheduledAt: 3, startedAt: null, endedAt: null },
  ]
  let receipt: CommandResult = { requestId: randomUUID(), status: 'done', data: {} }
  const call = vi.fn<Connection['call']>(async (method) => ({
    type: 'result',
    id: randomUUID(),
    ok: true,
    data: method === 'routines.history' ? history : data,
  }))
  const send = vi.fn<Connection['send']>(async () => receipt)
  const original: Connection = { snapshot: () => structuredClone(view), call, send }
  const connection: Connection = original
  const bridge = createRemoteRoutines({
    connection: (h) => (h === host ? connection : undefined),
    hosts: () => [host],
    label: () => 'bee1',
  })
  const invoke = async (channel: IpcInvokeChannel, args: unknown[]) =>
    bridge.route(channel, args)?.result
  const machine = `host:${host}`,
    key = `${machine}/${id}`
  const raw = { ...row, workspacePath: 'Repo label', machine: { repositoryId } }
  return {
    row,
    connection: original,
    host,
    id,
    runId,
    view,
    call,
    send,
    bridge,
    invoke,
    key,
    machine,
    raw,
    data: (value: unknown) => {
      data = value
    },
    history: (value: unknown) => {
      history = value
    },
    receipt: (value: CommandResult) => {
      receipt = value
    },
  }
}
it('blocks fresh mutations after unknown until a successful parsed list', async () => {
  const s = setup()
  s.receipt({ status: 'unknown', requestId: randomUUID() })
  await expect(s.invoke('routines:archive', [s.key])).rejects.toThrow(ROUTINE_UNKNOWN)
  s.data(null)
  await expect(s.invoke('routines:list', [s.machine])).rejects.toThrow(
    'Machine routines are unavailable.',
  )
  await expect(s.invoke('routines:delete', [s.key])).rejects.toThrow(ROUTINE_UNKNOWN)
  expect(s.send).toHaveBeenCalledTimes(1)
  s.data([s.row])
  await s.invoke('routines:list', [s.machine])
  s.receipt({ status: 'done', requestId: randomUUID(), data: {} })
  await s.invoke('routines:archive', [s.key])
  expect(s.send).toHaveBeenCalledTimes(2)
})

it('sends only wire configuration and creates disabled untrusted definitions', async () => {
  const s = setup()
  s.receipt({ status: 'done', requestId: randomUUID(), data: { routineId: s.id, revision: 1 } })
  await s.invoke('routines:save', [
    { ...s.raw, enabled: true, trusted: true, attention: '/private/host', label: 'renderer' },
    undefined,
    undefined,
    s.machine,
  ])
  const {
    id: _id,
    revision: _revision,
    createdAt: _created,
    updatedAt: _updated,
    nextAt: _next,
    archived: _archived,
    ...config
  } = s.row
  expect(s.send.mock.calls).toEqual([
    [
      {
        type: 'routine.save',
        expectedRevision: null,
        routine: { ...config, enabled: false, trusted: false },
      },
    ],
  ])
  const list = (await s.invoke('routines:list', [s.machine])) as RoutinesSnapshot
  expect(list.routines[0]?.workspacePath).toBe('Repo label')
  expect(JSON.stringify([list, s.bridge.machines()])).not.toContain('/private/host')
})

it('keeps confirmed run receipt identity when history fails without a retry', async () => {
  const s = setup()
  await s.invoke('routines:list', [s.machine])
  s.receipt({ status: 'done', requestId: randomUUID(), data: { runId: s.runId } })
  s.call.mockRejectedValueOnce(new Error('/private/host'))
  const run = (await s.invoke('routines:run', [s.key])) as RoutineRun
  expect(run).toMatchObject({
    id: `${s.machine}/${s.runId}`,
    routineId: s.key,
    trigger: 'manual',
    status: 'queued',
    sessionPath: null,
    workspacePath: null,
    scheduledAt: expect.any(Number),
  })
  expect(s.send).toHaveBeenCalledTimes(1)
  expect(s.call.mock.calls).toEqual([
    ['routines.list', {}],
    ['routines.history', { routineId: s.id, offset: 0 }],
  ])
})

it('rechecks same-object connection tokens after both query and mutation awaits', async () => {
  const s = setup()
  s.call.mockImplementationOnce(async () => {
    s.view.connectionToken = 'new-query-transport'
    return { type: 'result', id: randomUUID(), ok: true, data: [s.row] }
  })
  await expect(s.invoke('routines:list', [s.machine])).rejects.toThrow(
    'Machine routines are unavailable.',
  )
  s.send.mockImplementationOnce(async () => {
    s.view.connectionToken = 'new-mutation-transport'
    return { requestId: randomUUID(), status: 'done', data: {} }
  })
  await expect(s.invoke('routines:archive', [s.key])).rejects.toThrow(
    'Machine routines are unavailable.',
  )
  expect(s.send).toHaveBeenCalledTimes(1)
})
