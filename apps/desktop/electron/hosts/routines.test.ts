import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { newRoutine, type RoutinesSnapshot, type RoutineRun } from '@shared/routines'
import type { RemoteRoutine } from '@shared/host-protocol-routines'
import type { IpcInvokeChannel } from '@shared/ipc'
import { createRemoteRoutines, ROUTINE_UNKNOWN } from './routines'
import { createHostConnection } from './connection'
import { createFakeHost, createLoopbackPair } from '@shared/host-protocol-testing'
import type { GrantPayload } from '@shared/host-grant'
import type { CommandResult, HostConnectionSnapshot } from './connection'

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
  let connection: Connection | undefined = original
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
    stale: () => {
      connection = { ...original }
    },
    disconnect: () => {
      connection = undefined
    },
  }
}
it('routes opaque keys and repository labels without exposing Host paths; locals stay local', async () => {
  const s = setup()
  const list = (await s.invoke('routines:list', [s.machine])) as RoutinesSnapshot
  expect(list.routines[0]?.id).toBe(s.key)
  expect(list.routines[0]?.workspacePath).toBe('Repo label')
  expect(s.bridge.machines()[0]?.repositories).toEqual([
    { id: '0123456789abcdef', name: 'Repo label' },
  ])
  expect(JSON.stringify([list, s.bridge.machines()])).not.toContain('/private/host')
  expect(s.bridge.route('routines:list', [])).toBeNull()
  expect(s.bridge.route('routines:save', [s.raw, 'local-id'])).toBeNull()
  expect(s.bridge.route('routines:pauseAll', [])).toBeNull()
})
it.each(['routines:list', 'routines:history'] as const)(
  'refuses malformed untrusted %s',
  async (channel) => {
    const s = setup()
    if (channel === 'routines:list') s.data([{ ...s.row, path: '/private/host' }])
    s.history([
      {
        id: s.runId,
        routineId: s.id,
        status: 'queued',
        scheduledAt: 3,
        startedAt: null,
        endedAt: null,
        path: '/private/host',
      },
    ])
    await expect(
      s.invoke(channel, [channel === 'routines:list' ? s.machine : s.key, 0]),
    ).rejects.toThrow('unavailable')
  },
)
it('creation is paused and untrusted; explicit enable is a separate controller save', async () => {
  const s = setup()
  s.receipt({ status: 'done', requestId: randomUUID(), data: { routineId: s.id, revision: 1 } })
  await s.invoke('routines:save', [
    { ...s.raw, enabled: true, trusted: true },
    undefined,
    undefined,
    s.machine,
  ])
  expect(s.send.mock.calls[0]).toEqual([
    expect.objectContaining({
      type: 'routine.save',
      expectedRevision: null,
      routine: expect.objectContaining({
        enabled: false,
        trusted: false,
        repositoryId: '0123456789abcdef',
      }),
    }),
  ])
  expect(JSON.stringify(s.send.mock.calls)).not.toContain('workspacePath')
  await s.invoke('routines:save', [{ ...s.raw, enabled: true, trusted: true }, s.key, 1, s.machine])
  expect(s.send.mock.calls[1]?.[0]).toMatchObject({
    type: 'routine.save',
    routineId: s.id,
    expectedRevision: 1,
    routine: { enabled: true, trusted: true },
  })
})
for (const controlOp of ['run', 'delete', 'enabled save', 'trusted save']) {
  for (const caps of [
    ['routines'],
    ['sessions.control'],
    [],
  ] as HostConnectionSnapshot['capabilities'][]) {
    it(`never sends ${controlOp} with capabilities ${caps.join(',') || 'none'}`, async () => {
      const s = setup()
      await s.invoke('routines:list', [s.machine])
      s.view.capabilities = caps
      const channel: IpcInvokeChannel =
        controlOp === 'run'
          ? 'routines:run'
          : controlOp === 'delete'
            ? 'routines:delete'
            : 'routines:save'
      const args =
        channel === 'routines:save'
          ? [{ ...s.raw, enabled: controlOp === 'enabled save', trusted: true }, s.key, 1]
          : [s.key, randomUUID()]
      await expect(s.invoke(channel, args)).rejects.toThrow('unavailable')
      expect(s.send).not.toHaveBeenCalled()
    })
  }
}
it.each(['cancel', 'skipNext', 'archive', 'delete', 'pauseAll'] as const)(
  'routes %s as a machine receipt without a lane or fence',
  async (op) => {
    const s = setup()
    await s.invoke(`routines:${op}`, [op === 'pauseAll' ? s.machine : s.key])
    expect(s.send.mock.calls[0]).toEqual([
      op === 'pauseAll'
        ? { type: 'routine.pauseAll' }
        : op === 'cancel'
          ? { type: 'routine.cancel', runId: s.id }
          : { type: `routine.${op}`, routineId: s.id },
    ])
  },
)
it('refuses unknown repositories, stale edits and moving a definition to another machine', async () => {
  const s = setup()
  await expect(
    s.invoke('routines:save', [
      { ...s.raw, repositoryId: 'aaaaaaaaaaaaaaaa' },
      undefined,
      undefined,
      s.machine,
    ]),
  ).rejects.toThrow('unavailable')
  await expect(s.invoke('routines:save', [s.raw, s.key, undefined])).rejects.toThrow('unavailable')
  expect(() => s.bridge.route('routines:save', [s.raw, s.key, 1, `host:${randomUUID()}`])).toThrow(
    'unavailable',
  )
  expect(s.send).not.toHaveBeenCalled()
})
it('unknown receipt never resends until a parsed list refresh', async () => {
  const s = setup()
  s.receipt({ status: 'unknown', requestId: randomUUID() })
  await expect(s.invoke('routines:archive', [s.key])).rejects.toThrow(ROUTINE_UNKNOWN)
  await expect(s.invoke('routines:archive', [s.key])).rejects.toThrow(ROUTINE_UNKNOWN)
  expect(s.send).toHaveBeenCalledTimes(1)
  s.data(null)
  await expect(s.invoke('routines:list', [s.machine])).rejects.toThrow('unavailable')
  await expect(s.invoke('routines:archive', [s.key])).rejects.toThrow(ROUTINE_UNKNOWN)
  expect(s.send).toHaveBeenCalledTimes(1)
})
it('refuses malicious receipt fields without surfacing diagnostic content', async () => {
  const s = setup()
  s.receipt({ status: 'done', requestId: randomUUID(), data: { path: '/private/host' } })
  await expect(s.invoke('routines:archive', [s.key])).rejects.toThrow('unavailable')
})
it.each(['replace', 'disconnect', 'lose-capability'] as const)(
  'rechecks %s after query and mutation awaits',
  async (change) => {
    const s = setup()
    const changeConnection = () =>
      change === 'replace'
        ? s.stale()
        : change === 'disconnect'
          ? s.disconnect()
          : (s.view.capabilities = [])
    s.call.mockImplementationOnce(async () => {
      changeConnection()
      return { type: 'result', id: randomUUID(), ok: true, data: [] }
    })
    await expect(s.invoke('routines:list', [s.machine])).rejects.toThrow('unavailable')
    const m = setup()
    m.send.mockImplementationOnce(async () => {
      if (change === 'replace') m.stale()
      else if (change === 'disconnect') m.disconnect()
      else m.view.capabilities = []
      return { status: 'done', requestId: randomUUID(), data: {} }
    })
    await expect(m.invoke('routines:archive', [m.key])).rejects.toThrow('unavailable')
  },
)
it.each(['found', 'not-found', 'malformed', 'failed'] as const)(
  'returns a safe run after a confirmed receipt with %s history',
  async (mode) => {
    const s = setup()
    await s.invoke('routines:list', [s.machine])
    if (mode === 'not-found') s.history([])
    if (mode === 'malformed') s.history([{ path: '/private/host' }])
    if (mode === 'failed')
      s.call.mockImplementationOnce(async () => {
        throw new Error('/private/host')
      })
    s.receipt({ status: 'done', requestId: randomUUID(), data: { runId: s.runId } })
    const run = (await s.invoke('routines:run', [s.key, randomUUID()])) as RoutineRun
    expect(run.id).toBe(`${s.machine}/${s.runId}`)
    expect(run.status).toBe('queued')
    expect(run.trigger).toBe('manual')
    expect(run.sessionPath).toBeNull()
    expect(run.workspacePath).toBeNull()
    expect(run.scheduledAt).toEqual(mode === 'found' ? 3 : expect.any(Number))
    expect(s.send).toHaveBeenCalledTimes(1)
    expect(s.call.mock.calls.filter(([method]) => method === 'routines.history')).toHaveLength(1)
  },
)

it('rechecks a connection replaced during the second history await', async () => {
  const s = setup()
  s.call.mockImplementationOnce(async () => ({
    type: 'result',
    id: randomUUID(),
    ok: true,
    data: [
      {
        id: s.runId,
        routineId: s.id,
        status: 'queued',
        scheduledAt: 3,
        startedAt: null,
        endedAt: null,
      },
    ],
  }))
  s.call.mockImplementationOnce(async () => {
    s.stale()
    return { type: 'result', id: randomUUID(), ok: true, data: [] }
  })
  await expect(s.invoke('routines:history', [s.key, 0])).rejects.toThrow('unavailable')
})

it('dispatches routines-changed on the lanes topic, ignores duplicate and wrong epoch invalidations', async () => {
  vi.useFakeTimers()
  const keys = generateKeyPairSync('ed25519'),
    hostId = randomUUID()
  const claims: GrantPayload = {
    v: 1,
    iss: 'http://localhost:12345',
    kid: 'test',
    sub: randomUUID(),
    sid: randomUUID(),
    hostId,
    epoch: 1,
    client: { id: randomUUID(), label: 'Desktop' },
    caps: ['sessions.read', 'routines'],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: '0123456789abcdef',
  }
  const host = createFakeHost({
    expectations: { iss: claims.iss, hostId, owner: claims.sub, epoch: 1 },
    id: randomUUID,
    epoch: () => '0123456789abcdef',
    verify: () => true,
    verifyGrant: () => claims,
    capabilities: ['sessions.read', 'routines'],
    sign: (bytes) => sign(null, bytes, keys.privateKey),
  })
  const pair = createLoopbackPair()
  const changed = vi.fn(),
    hostChanged = vi.fn()
  const publicKey = keys.publicKey.export({ format: 'jwk' }).x
  if (!publicKey) throw new Error('Missing public key')
  const connection = createHostConnection({
    hostId,
    endpoint: 'https://bee.tail.ts.net:47615',
    socket: async () => {
      host.attach(pair.server)
      return pair.client
    },
    grant: async () => ({
      grant: 'test',
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      host: { id: hostId, publicKey, endpoint: 'https://bee.tail.ts.net:47615' },
    }),
    clearGrant: () => {},
    changed: hostChanged,
    onRoutinesChanged: changed,
  })
  try {
    for (let i = 0; i < 40; i++) await Promise.resolve()
    const cursor = connection.snapshot().cursor
    expect(cursor).toBeDefined()
    if (!cursor) throw new Error('Missing cursor')
    const hostChanges = hostChanged.mock.calls.length
    const event = {
      type: 'routines-changed',
      id: 'lanes',
      cursor: { ...cursor, seq: cursor.seq + 1 },
    }
    pair.server.send(JSON.stringify(event))
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(hostChanged).toHaveBeenCalledTimes(hostChanges)
    pair.server.send(JSON.stringify(event))
    pair.server.send(
      JSON.stringify({ ...event, cursor: { epoch: 'aaaaaaaaaaaaaaaa', seq: cursor.seq + 2 } }),
    )
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(changed).toHaveBeenCalledTimes(1)
  } finally {
    connection.close()
    host.stop()
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

it('refuses unknown machine ids without forwarding and routes only to the requested machine', async () => {
  const s = setup()
  await expect(s.invoke('routines:list', [`host:${randomUUID()}`])).rejects.toThrow(
    'Machine routines are unavailable.',
  )
  expect(s.call).not.toHaveBeenCalled()
  await s.invoke('routines:list', [s.machine])
  expect(s.call).toHaveBeenCalledTimes(1)
  expect(s.call).toHaveBeenCalledWith('routines.list', {})
})

it('refuses changing an existing routine to another admitted machine', () => {
  const s = setup(),
    other = randomUUID()
  const bridge = createRemoteRoutines({
    connection: () => s.connection,
    hosts: () => [s.host, other],
    label: () => 'machine',
  })
  expect(() => bridge.route('routines:save', [s.raw, s.key, 1, `host:${other}`])).toThrow(
    'unavailable',
  )
  expect(s.send).not.toHaveBeenCalled()
})

it('refuses a non-ready machine before sending and rechecks readiness after awaits', async () => {
  const s = setup()
  s.view.state = 'reconnecting'
  await expect(s.invoke('routines:list', [s.machine])).rejects.toThrow('unavailable')
  expect(s.call).not.toHaveBeenCalled()
  expect(s.bridge.machines()[0]?.available).toBe(false)
  s.view.state = 'ready'
  s.call.mockImplementationOnce(async () => {
    s.view.state = 'reconnecting'
    return { type: 'result', id: randomUUID(), ok: true, data: [s.row] }
  })
  await expect(s.invoke('routines:list', [s.machine])).rejects.toThrow('unavailable')
})
it('refuses history rows for another routine and a renderer offset the parser rejects', async () => {
  const s = setup()
  await s.invoke('routines:list', [s.machine])
  s.history([
    {
      id: s.runId,
      routineId: randomUUID(),
      status: 'queued',
      scheduledAt: 3,
      startedAt: null,
      endedAt: null,
    },
  ])
  await expect(s.invoke('routines:history', [s.key, 0])).rejects.toThrow('unavailable')
  s.call.mockClear()
  await expect(s.invoke('routines:history', [s.key, 'not a number'])).rejects.toThrow('unavailable')
  expect(s.call).not.toHaveBeenCalled()
})
it('refuses a listed routine whose repository the machine does not announce', async () => {
  const s = setup()
  s.data([{ ...s.row, repositoryId: 'fedcba9876543210' }])
  await expect(s.invoke('routines:list', [s.machine])).rejects.toThrow('unavailable')
})
it('a manual run returns the run named by its receipt, not a newer one in history', async () => {
  const s = setup()
  await s.invoke('routines:list', [s.machine])
  const other = randomUUID()
  s.history([
    { id: other, routineId: s.id, status: 'running', scheduledAt: 9, startedAt: 9, endedAt: null },
    {
      id: s.runId,
      routineId: s.id,
      status: 'queued',
      scheduledAt: 3,
      startedAt: null,
      endedAt: null,
    },
  ])
  s.receipt({ requestId: randomUUID(), status: 'done', data: { runId: s.runId } })
  const run = (await s.invoke('routines:run', [s.key, randomUUID()])) as RoutineRun
  expect(run.id).toBe(`${s.machine}/${s.runId}`)
  expect(run.status).toBe('queued')
  expect(run.trigger).toBe('manual')
})
