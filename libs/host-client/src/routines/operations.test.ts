import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { newRoutine } from '@phosphor/shared/routines'
import type { RemoteRoutine } from '@phosphor/shared/host-protocol-routines'
import type { HostConnectionSnapshot } from '../connection'
import { admitted, history, list, mapRoutine, mutate, query, run, runRecord } from './operations'
import {
  createRemoteRoutineState,
  ROUTINE_UNKNOWN,
  UNAVAILABLE,
  type Connection,
  type RemoteRoutinePorts,
} from './state'

function setup() {
  const host = randomUUID(),
    id = randomUUID(),
    runId = randomUUID()
  const repositoryId = '0123456789abcdef'
  const { workspacePath: _path, ...config } = newRoutine('unused')
  const input = {
    ...config,
    name: 'Task',
    instructions: 'Review',
    provider: 'test',
    model: 'test',
    repositoryId,
  }
  const row: RemoteRoutine = {
    ...input,
    id,
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    nextAt: null,
    archived: false,
  }
  const view: HostConnectionSnapshot = {
    connectionToken: 'initial',
    state: 'ready',
    capabilities: ['routines', 'sessions.control'],
    repositories: [{ id: repositoryId, name: 'Repo label', path: '/private/host' }],
    lanes: [],
  }
  const remoteRun = {
    id: runId,
    routineId: id,
    status: 'finished' as const,
    scheduledAt: 3,
    startedAt: 4,
    endedAt: 5,
  }
  const call = vi.fn<Connection['call']>(async (method) => ({
    type: 'result',
    id: randomUUID(),
    ok: true,
    data: method === 'routines.history' ? [remoteRun] : [row],
  }))
  const send = vi.fn<Connection['send']>(async () => ({
    status: 'done',
    requestId: randomUUID(),
    data: {},
  }))
  const connection: Connection = { snapshot: () => structuredClone(view), call, send }
  const ports: RemoteRoutinePorts = {
    connection: (h) => (h === host ? connection : undefined),
    hosts: () => [host],
    label: () => 'Host label',
  }
  return {
    state: createRemoteRoutineState(),
    ports,
    connection,
    view,
    call,
    send,
    host,
    id,
    runId,
    row,
    remoteRun,
    input,
  }
}

it('requires ready routines admission, matching connection identity and transport token', () => {
  const s = setup()
  expect(admitted(s.ports, s.host)).toBe(s.connection)
  expect(() => admitted(s.ports, 'missing')).toThrow(UNAVAILABLE)
  expect(() => admitted(s.ports, s.host, false, { ...s.connection })).toThrow(UNAVAILABLE)
  expect(() => admitted(s.ports, s.host, false, s.connection, 'stale')).toThrow(UNAVAILABLE)
  s.view.state = 'reconnecting'
  expect(() => admitted(s.ports, s.host)).toThrow(UNAVAILABLE)
  s.view.state = 'ready'
  s.view.capabilities = ['sessions.control']
  expect(() => admitted(s.ports, s.host)).toThrow(UNAVAILABLE)
  s.view.capabilities = ['routines']
  expect(admitted(s.ports, s.host)).toBe(s.connection)
  expect(() => admitted(s.ports, s.host, true)).toThrow(UNAVAILABLE)
})

it('validates query params before calling and replaces rejected or negative results with fixed errors', async () => {
  const s = setup()
  await expect(query(s.ports, s.host, 'routines.list', { path: '/private' })).rejects.toThrow(
    UNAVAILABLE,
  )
  expect(s.call).not.toHaveBeenCalled()
  s.call.mockRejectedValueOnce(new Error('/private/host'))
  await expect(query(s.ports, s.host, 'routines.list', {})).rejects.toThrow(UNAVAILABLE)
  s.call.mockResolvedValueOnce({
    type: 'result',
    id: randomUUID(),
    ok: false,
    error: { code: 'forbidden', message: '/private/host' },
  })
  await expect(query(s.ports, s.host, 'routines.list', {})).rejects.toThrow(UNAVAILABLE)
})

it('maps definitions and run records to opaque ids and redacts paths and diagnostics', async () => {
  const s = setup()
  const definition = mapRoutine(s.ports, s.host, s.row)
  expect(definition).toMatchObject({
    id: `host:${s.host}/${s.id}`,
    workspacePath: 'Repo label',
    attention: null,
    machine: {
      id: `host:${s.host}`,
      label: 'Host label',
      repositoryId: s.row.repositoryId,
      control: true,
    },
  })
  const record = runRecord(s.host, s.remoteRun, definition)
  expect(record).toEqual({
    ...s.remoteRun,
    id: `host:${s.host}/${s.runId}`,
    routineId: definition.id,
    definition,
    trigger: 'schedule',
    createdAt: 3,
    reason: '',
    summary: '',
    sessionId: null,
    sessionPath: null,
    workspacePath: null,
    branch: null,
    baseCommit: null,
    accountId: null,
  })
  expect(await history(s.state, s.ports, s.host, s.id, 0)).toEqual([record])
  expect(s.call.mock.calls.map(([method]) => method)).toEqual(['routines.history', 'routines.list'])
  s.view.repositories = []
  expect(() => mapRoutine(s.ports, s.host, s.row)).toThrow(UNAVAILABLE)
})

it.each(['unknown', 'pending', 'throw', 'malformed'] as const)(
  'blocks fresh sends after a %s outcome until a valid list',
  async (mode) => {
    const s = setup()
    if (mode === 'throw') s.send.mockRejectedValueOnce(new Error('/private/host'))
    else
      s.send.mockResolvedValueOnce({
        requestId: randomUUID(),
        status: mode === 'malformed' ? 'done' : mode,
        data: { path: '/private/host' },
      })
    await expect(mutate(s.state, s.ports, s.host, { type: 'routine.pauseAll' })).rejects.toThrow(
      mode === 'malformed' ? UNAVAILABLE : ROUTINE_UNKNOWN,
    )
    await expect(mutate(s.state, s.ports, s.host, { type: 'routine.pauseAll' })).rejects.toThrow(
      ROUTINE_UNKNOWN,
    )
    expect(s.send).toHaveBeenCalledTimes(1)
    s.call.mockResolvedValueOnce({ type: 'result', id: randomUUID(), ok: true, data: null })
    await expect(list(s.state, s.ports, s.host)).rejects.toThrow(UNAVAILABLE)
    expect(s.state.uncertain.has(s.host)).toBe(true)
    await list(s.state, s.ports, s.host)
    expect(s.state.uncertain.has(s.host)).toBe(false)
  },
)

it('rejects malformed ops, unknown repositories and run mutations without control before sending', async () => {
  const s = setup()
  await expect(mutate(s.state, s.ports, s.host, { type: 'other' })).rejects.toThrow(UNAVAILABLE)
  await expect(
    mutate(s.state, s.ports, s.host, {
      type: 'routine.save',
      routine: { ...s.input, repositoryId: 'aaaaaaaaaaaaaaaa' },
      expectedRevision: null,
    }),
  ).rejects.toThrow(UNAVAILABLE)
  s.view.capabilities = ['routines']
  await expect(
    mutate(s.state, s.ports, s.host, { type: 'routine.run', routineId: s.id }),
  ).rejects.toThrow(UNAVAILABLE)
  expect(s.send).not.toHaveBeenCalled()
})

it('returns a fixed failure for a non-completed receipt without exposing diagnostics', async () => {
  const s = setup()
  s.send.mockResolvedValueOnce({ requestId: randomUUID(), status: 'not-sent', reason: 'closed' })
  await expect(mutate(s.state, s.ports, s.host, { type: 'routine.pauseAll' })).rejects.toThrow(
    'Routine operation was not completed. Refresh before taking another action.',
  )
  expect(s.state.uncertain.size).toBe(0)
})

it('uses the confirmed run id and cached definition without retrying failed history', async () => {
  const s = setup()
  await list(s.state, s.ports, s.host)
  s.send.mockResolvedValueOnce({
    requestId: randomUUID(),
    status: 'done',
    data: { runId: s.runId },
  })
  s.call.mockRejectedValueOnce(new Error('/private/host'))
  expect(await run(s.state, s.ports, s.host, s.id)).toMatchObject({
    id: `host:${s.host}/${s.runId}`,
    routineId: `host:${s.host}/${s.id}`,
    trigger: 'manual',
    status: 'queued',
    scheduledAt: expect.any(Number),
    sessionPath: null,
    workspacePath: null,
  })
  expect(s.send).toHaveBeenCalledTimes(1)
})

it('keeps token admission checks after awaited queries, sends and history fallback', async () => {
  const s = setup()
  s.call.mockImplementationOnce(async () => {
    s.view.connectionToken = 'next'
    return { type: 'result', id: randomUUID(), ok: true, data: [s.row] }
  })
  await expect(list(s.state, s.ports, s.host)).rejects.toThrow(UNAVAILABLE)
  await list(s.state, s.ports, s.host)
  s.send.mockImplementationOnce(async () => {
    s.view.connectionToken = 'next-send'
    return { requestId: randomUUID(), status: 'done', data: {} }
  })
  await expect(mutate(s.state, s.ports, s.host, { type: 'routine.pauseAll' })).rejects.toThrow(
    UNAVAILABLE,
  )
  s.send.mockResolvedValueOnce({
    requestId: randomUUID(),
    status: 'done',
    data: { runId: s.runId },
  })
  s.call.mockImplementationOnce(async () => {
    s.view.connectionToken = 'next-history'
    throw new Error('/private/host')
  })
  await expect(run(s.state, s.ports, s.host, s.id)).rejects.toThrow(UNAVAILABLE)
  expect(s.send).toHaveBeenCalledTimes(2)
})
