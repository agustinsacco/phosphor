import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserApi } from './index'
import { createFakeHost, createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import { formatKeyFingerprint, type MachineView } from '@phosphor/shared/control-api'
import { type GrantPayload } from '@phosphor/shared/host-grant'
import type { ClientFrame } from '@phosphor/shared/host-protocol'
import { browserCrypto } from '@phosphor/host-client/crypto'

const disposals: (() => void)[] = []
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()))
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
async function setup(
  options: {
    grant?: 'deny' | 'wrong-endpoint' | 'wrong-key' | 'expired'
    proof?: () => Promise<boolean>
    expires?: number
  } = {},
) {
  const owner = randomUUID(),
    clientId = randomUUID()
  const machines: MachineView[] = []
  const frames: { host: string; frame: ClientFrame }[] = []
  const delivery = {
    hold: (_host: string, _text: string) => false,
    pending: [] as (() => void)[],
    release() {
      for (const send of this.pending.splice(0)) send()
    },
  }
  const endpoints = new Map<string, ReturnType<typeof createFakeHost>>()
  const publicKeys = new Map<string, string>()
  const hosts = []
  for (let index = 0; index < 2; index++) {
    const hostId = randomUUID(),
      endpoint = `https://fixture${index}.tail.ts.net:47615`
    const keys = generateKeyPairSync('ed25519'),
      publicKey = keys.publicKey.export({ format: 'jwk' }).x!
    publicKeys.set(hostId, publicKey)
    const machine: MachineView = {
      id: hostId,
      endpoint,
      label: `Fixture ${index}`,
      hostname: `fixture${index}`,
      platform: 'linux',
      arch: 'x64',
      hostVersion: '1.0.0',
      keyFingerprint: formatKeyFingerprint(
        createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest(),
      ),
      enrolledAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      state: 'running',
      readiness: null,
      lanes: null,
    }
    machines.push(machine)
    const claims = (): GrantPayload => ({
      v: 1,
      iss: 'https://control.invalid',
      kid: 'fixture',
      sub: owner,
      sid: owner,
      hostId,
      epoch: 1,
      client: { id: clientId, label: 'Browser fixture' },
      caps: ['sessions.read', 'sessions.control'],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (options.expires ?? 300),
      jti: '0123456789abcdef',
    })
    const host = createFakeHost({
      expectations: { iss: 'https://control.invalid', hostId, owner, epoch: 1 },
      id: randomUUID,
      epoch: () => '0123456789abcdef',
      verify: () => true,
      verifyGrant: () => claims(),
      sign: (bytes) => sign(null, bytes, keys.privateKey),
    })
    endpoints.set(`${endpoint.replace('https:', 'wss:')}/v1/stream`, host)
    hosts.push(host)
    disposals.push(host.stop)
  }
  let signedIn = true
  const fetch = vi.fn<typeof globalThis.fetch>(async (path, init) => {
    if (path === '/api/auth/session')
      return signedIn
        ? json({ user: { id: owner, login: 'fixture' }, clientId, csrfToken: 'a'.repeat(43) })
        : json({}, 401)
    if (path === '/api/auth/signout') {
      signedIn = false
      return json({ signedOut: true, remoteCleanup: 'complete' })
    }
    if (path === '/api/v1/machines') return json({ machines, serverTime: new Date().toISOString() })
    if (path === '/api/v1/grants') {
      if (options.grant === 'deny')
        return json({ error: { code: 'not-found', message: 'Refused' } }, 404)
      const { hostId } = JSON.parse(String(init?.body))
      const machine = machines.find((m) => m.id === hostId)!
      return json({
        grant: `phosphor-grant.v1.YQ.${'A'.repeat(86)}`,
        expiresAt: new Date(
          Date.now() + (options.grant === 'expired' ? -1000 : (options.expires ?? 300) * 1000),
        ).toISOString(),
        host: {
          id: hostId,
          endpoint:
            options.grant === 'wrong-endpoint' ? 'https://other.tail.ts.net' : machine.endpoint,
          publicKey: options.grant === 'wrong-key' ? 'A'.repeat(43) : publicKeys.get(hostId),
        },
      })
    }
    throw new Error('Unexpected fixture request')
  })
  const socket = vi.fn(async (url: string) => {
    const host = endpoints.get(url)
    if (!host) throw new Error('Unenrolled endpoint')
    const pair = createLoopbackPair()
    const id = machines.find(
      (m) => `${m.endpoint?.replace('https:', 'wss:')}/v1/stream` === url,
    )!.id
    pair.server.onMessage((text) => frames.push({ host: id, frame: JSON.parse(text) }))
    host.attach(pair.server)
    return {
      ...pair.client,
      onMessage: (listener: (text: string) => void) =>
        pair.client.onMessage((text) => {
          if (delivery.hold(id, text)) delivery.pending.push(() => listener(text))
          else listener(text)
        }),
    }
  })
  const adapter = createBrowserApi({
    fetch,
    socket,
    storage: null,
    invalidation: null,
    lifecycle: { subscribe: () => () => {} },
    ...(options.proof ? { identity: { ...browserCrypto, verify: options.proof } } : {}),
  })
  // Adapter closes first, before the synthetic Host services.
  disposals.unshift(adapter.dispose)
  await adapter.start()
  const ready = async () =>
    vi.waitFor(async () => {
      const views = await adapter.api.invoke('hosts:snapshot')
      expect(Object.values(views).map((v) => v.state)).toEqual(['ready', 'ready'])
    })
  return { ...adapter, machines, frames, hosts, fetch, socket, ready, delivery }
}
it('uses shared lane hydration, approvals, reply, control and memory-only handles on the exact Host', async () => {
  const s = await setup()
  await s.ready()
  const host = s.machines[0]!.id,
    other = s.machines[1]!.id
  const lane = await s.api.invoke('hosts:createLane', host, { repositoryId: '0123456789abcdef' })
  expect(lane.sessionId).toMatch(/^remote-[a-f0-9]{16}$/)
  expect(lane.workspacePath).toBe(`host:${host}/lane:${lane.laneId}`)
  await s.api.invoke('hosts:setFocusedLane', { hostId: host, laneId: lane.laneId! })
  expect(await s.api.piCommand(lane.sessionId, { type: 'get_state' })).toMatchObject({
    success: true,
  })
  const pushed: unknown[] = []
  s.api.onSessionPush(lane.sessionId, (push) => pushed.push(push))
  await s.api.piCommand(lane.sessionId, { type: 'get_messages' })
  const dialog = randomUUID()
  s.hosts[0]!.openDialog(lane.laneId!, dialog)
  await vi.waitFor(() =>
    expect(pushed).toContainEqual(expect.objectContaining({ kind: 'extension-ui' })),
  )
  await s.api.invoke('pi:extensionUiResponse', lane.sessionId, {
    type: 'extension_ui_response',
    id: dialog,
    confirmed: true,
  })
  expect(
    await s.api.piCommand(lane.sessionId, { type: 'prompt', message: 'Synthetic test message' }),
  ).toMatchObject({ success: true })
  await s.api.invoke('hosts:releaseControl', host, lane.laneId!)
  await s.api.invoke('hosts:takeControl', host, lane.laneId!)
  await s.api.invoke('hosts:stopLane', host, lane.laneId!)
  await s.api.invoke('hosts:resumeLane', host, lane.laneId!)
  await s.api.invoke('hosts:markRead', host, lane.laneId!)
  const before = s.frames.length
  await expect(s.api.invoke('hosts:openLane', other, lane.laneId!)).rejects.toThrow()
  await expect(
    s.api.invoke('fs:readFile', `host:${other}/lane:${lane.laneId}/file.txt`),
  ).rejects.toThrow()
  await expect(s.api.invoke('fs:readFile', '/local/file.txt')).rejects.toThrow()
  expect(s.frames.length).toBe(before)
  expect(s.frames.filter((f) => f.frame.type === 'command').every((f) => f.host === host)).toBe(
    true,
  )
  await s.api.invoke('account:signOut')
  expect(await s.api.invoke('pi:listLiveSessions')).toEqual([])
  expect(await s.api.invoke('hosts:snapshot')).toEqual({})
  expect(await s.api.piCommand(lane.sessionId, { type: 'get_messages' })).toMatchObject({
    success: false,
  })
})
it.each(['deny', 'wrong-endpoint', 'wrong-key', 'expired'] as const)(
  'refuses %s grants before any socket, including explicit reconnect',
  async (grant) => {
    const s = await setup({ grant })
    await vi.waitFor(async () =>
      expect(
        Object.values(await s.api.invoke('hosts:snapshot')).every(
          (v) => v.lastError === 'grant-refused',
        ),
      ).toBe(true),
    )
    expect(s.socket).not.toHaveBeenCalled()
    await s.api.invoke('hosts:reconnect', s.machines[0]!.id)
    await vi.waitFor(() =>
      expect(s.fetch.mock.calls.filter(([p]) => p === '/api/v1/grants').length).toBeGreaterThan(2),
    )
    expect(s.socket).not.toHaveBeenCalled()
  },
)
it('drops a delayed identity proof after logout; it cannot publish ready or subscribe', async () => {
  let release!: (valid: boolean) => void
  const proof = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve
      }),
  )
  const s = await setup({ proof })
  await vi.waitFor(() => expect(proof).toHaveBeenCalledTimes(2))
  await s.api.invoke('account:signOut')
  release(true)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(await s.api.invoke('hosts:snapshot')).toEqual({})
  expect(s.frames.some((f) => f.frame.type === 'subscribe')).toBe(false)
})
it('renews short-lived grants in memory without registering a new client', async () => {
  const s = await setup({ expires: 5 })
  await s.ready()
  await vi.waitFor(
    () =>
      expect(
        s.fetch.mock.calls.filter(([p]) => p === '/api/v1/grants').length,
      ).toBeGreaterThanOrEqual(4),
    { timeout: 2500 },
  )
  expect(s.fetch.mock.calls.some(([p]) => p === '/api/v1/clients')).toBe(false)
})

it('fences pending grants across repeated reconnects and logout', async () => {
  const s = await setup()
  await s.ready()
  const original = s.fetch.getMockImplementation()!
  const release: (() => void)[] = []
  s.fetch.mockImplementation(async (path, init) => {
    const response = await original(path, init)
    if (path === '/api/v1/grants') await new Promise<void>((resolve) => release.push(resolve))
    return response
  })
  const id = s.machines[0]!.id
  await s.api.invoke('hosts:reconnect', id)
  await vi.waitFor(() => expect(release).toHaveLength(1))
  await s.api.invoke('hosts:reconnect', id)
  await vi.waitFor(() => expect(release).toHaveLength(2))
  const opened = s.socket.mock.calls.length
  release[0]!()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(s.socket.mock.calls.length).toBe(opened)
  await s.api.invoke('account:signOut')
  release[1]!()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(s.socket.mock.calls.length).toBe(opened)
  expect(await s.api.invoke('hosts:snapshot')).toEqual({})
})

it('closes connections and projections when the cookie expires on revalidation', async () => {
  const s = await setup()
  await s.ready()
  const original = s.fetch.getMockImplementation()!
  s.fetch.mockImplementation((path, init) =>
    path === '/api/auth/session' ? Promise.resolve(json({}, 401)) : original(path, init),
  )
  await s.start()
  expect(await s.api.invoke('account:get')).toMatchObject({ account: { status: 'signed-out' } })
  expect(await s.api.invoke('hosts:snapshot')).toEqual({})
})

it('reports wrong-machine proof separately from grant refusal', async () => {
  const s = await setup({ proof: async () => false })
  await vi.waitFor(async () =>
    expect(
      Object.values(await s.api.invoke('hosts:snapshot')).every(
        (view) => view.state === 'wrong-machine',
      ),
    ).toBe(true),
  )
})

it.each(['prompt', 'create'] as const)(
  'keeps Host A confirmed %s successful while Host B reconnects',
  async (operation) => {
    const s = await setup()
    await s.ready()
    const [a, b] = s.machines.map((machine) => machine.id) as [string, string]
    const lane = await s.api.invoke('hosts:createLane', a, { repositoryId: '0123456789abcdef' })
    s.delivery.hold = (host, text) => {
      const frame = JSON.parse(text)
      return (
        host === a &&
        (operation === 'create'
          ? frame.type === 'snapshot'
          : frame.type === 'receipt' && frame.receipt.status === 'done')
      )
    }
    const result = (
      operation === 'prompt'
        ? s.api.piCommand(lane.sessionId, { type: 'prompt', message: 'Synthetic reply' })
        : s.api.invoke('hosts:createLane', a, { repositoryId: '0123456789abcdef' })
    ).then(
      (value) => ({ value }),
      () => ({ failed: true }),
    )
    await vi.waitFor(() => expect(s.delivery.pending.length).toBeGreaterThan(0))
    await s.api.invoke('hosts:reconnect', b)
    await s.ready()
    s.delivery.hold = () => false
    s.delivery.release()
    expect(await result).toMatchObject(
      operation === 'prompt'
        ? { value: { success: true } }
        : { value: { target: { kind: 'remote', hostId: a } } },
    )
    const commands = s.frames.filter(
      ({ host, frame }) =>
        host === a &&
        frame.type === 'command' &&
        frame.op.type === (operation === 'prompt' ? 'prompt' : 'lane.create'),
    )
    expect(commands).toHaveLength(operation === 'prompt' ? 1 : 2)
  },
)

it.each(['reconnect', 'logout'] as const)(
  'fences a delayed lane state result after its own %s',
  async (action) => {
    const s = await setup()
    await s.ready()
    const a = s.machines[0]!.id
    const lane = await s.api.invoke('hosts:createLane', a, { repositoryId: '0123456789abcdef' })
    await s.api.piCommand(lane.sessionId, { type: 'get_messages' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    s.delivery.hold = (host, text) => host === a && JSON.parse(text).type === 'result'
    const result = s.api.piCommand(lane.sessionId, { type: 'get_state' })
    await vi.waitFor(() => expect(s.delivery.pending.length).toBeGreaterThan(0))
    if (action === 'reconnect') await s.api.invoke('hosts:reconnect', a)
    else await s.api.invoke('account:signOut')
    s.delivery.hold = () => false
    s.delivery.release()
    expect(await result).toMatchObject({ success: false })
    expect(await result).not.toHaveProperty('data')
  },
)
