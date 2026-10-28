import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserApi } from './index'
import { createFakeHost, createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import { formatKeyFingerprint, type MachineView } from '@phosphor/shared/control-api'
import { encodeGrant, splitGrant, type GrantPayload } from '@phosphor/shared/host-grant'
import { IPC_WEB } from '@phosphor/shared/ipc-web'

const disposals: (() => void)[] = []
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()))
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const CONFIGURATION_CHANNELS = [
  'hosts:deleteLane',
  'hosts:settingsAccess',
  'hosts:settingsRead',
  'hosts:settingsPatch',
  'hosts:settingsCheck',
  'hosts:machineTask',
  'hosts:claudeAccount',
] as const

/** An enrolled, updated Host: it announces settings and honours signed configure grants. */
function fixtureHost() {
  const owner = randomUUID(),
    hostId = randomUUID(),
    endpoint = 'https://fixture.tail.ts.net:47615'
  const keys = generateKeyPairSync('ed25519'),
    publicKey = keys.publicKey.export({ format: 'jwk' }).x!
  const machine: MachineView = {
    id: hostId,
    endpoint,
    label: 'Fixture',
    hostname: 'fixture',
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
  const claims = (clientId: string, configure: boolean): GrantPayload => ({
    v: 1,
    iss: 'https://control.invalid',
    kid: 'fixture',
    sub: owner,
    sid: owner,
    hostId,
    epoch: 1,
    client: { id: clientId, label: 'Browser fixture' },
    caps: ['sessions.read', 'sessions.control'],
    ...(configure ? { configure: true as const } : {}),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: '0123456789abcdef',
  })
  const host = createFakeHost({
    expectations: { iss: 'https://control.invalid', hostId, owner, epoch: 1 },
    id: randomUUID,
    epoch: () => '0123456789abcdef',
    verify: () => true,
    // As the real Host does: a signed configure opt-in adds machine.configure.
    verifyGrant: (token) => {
      const parsed = splitGrant(token)
      if (!parsed.ok) return null
      const payload = parsed.value.payload
      return payload.configure
        ? { ...payload, caps: [...payload.caps, 'machine.configure'] }
        : payload
    },
    capabilities: ['sessions.read', 'sessions.control', 'machine.configure'],
    sign: (bytes) => sign(null, bytes, keys.privateKey),
  })
  disposals.push(host.stop)
  const socket = vi.fn(async () => {
    const pair = createLoopbackPair()
    host.attach(pair.server)
    return {
      ...pair.client,
      // An updated Host announces its settings API in the ready frame.
      onMessage: (listener: (text: string) => void) =>
        pair.client.onMessage((text) => {
          const frame = JSON.parse(text) as { type?: string }
          listener(frame.type === 'ready' ? JSON.stringify({ ...frame, settings: true }) : text)
        }),
    }
  })
  return { owner, hostId, endpoint, publicKey, machine, claims, socket }
}

/** That Host behind real browser control, grants and Host connection code. */
async function setup(options: { control?: 'old' } = {}) {
  const f = fixtureHost()
  let clientId = randomUUID(),
    signedIn = true
  const grantRequests: { configure?: unknown }[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (path, init) => {
    if (path === '/api/auth/session')
      return signedIn
        ? json({ user: { id: f.owner, login: 'fixture' }, clientId, csrfToken: 'a'.repeat(43) })
        : json({}, 401)
    if (path === '/api/auth/signout') {
      signedIn = false
      return json({ signedOut: true, remoteCleanup: 'complete' })
    }
    if (path === '/api/v1/machines')
      return json({ machines: [f.machine], serverTime: new Date().toISOString() })
    if (path === '/api/v1/grants') {
      const body = JSON.parse(String(init?.body)) as { configure?: unknown }
      grantRequests.push(body)
      const configure = body.configure === true && options.control !== 'old'
      return json({
        grant: encodeGrant(f.claims(clientId, configure), () => new Uint8Array(64)),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        host: { id: f.hostId, endpoint: f.endpoint, publicKey: f.publicKey },
      })
    }
    throw new Error('Unexpected fixture request')
  })
  const adapter = createBrowserApi({
    fetch,
    socket: f.socket,
    navigate: () => {},
    storage: null,
    invalidation: null,
    lifecycle: { subscribe: () => () => {} },
  })
  disposals.unshift(adapter.dispose)
  await adapter.start()
  const view = async () => (await adapter.api.invoke('hosts:snapshot'))[f.hostId]
  const ready = (configure: boolean) =>
    vi.waitFor(async () => {
      const current = await view()
      expect(current?.state).toBe('ready')
      expect(current?.capabilities.includes('machine.configure')).toBe(configure)
    })
  return {
    ...adapter,
    hostId: f.hostId,
    grantRequests,
    ready,
    view,
    signIn: () => {
      signedIn = true
    },
    newClient: () => {
      clientId = randomUUID()
    },
  }
}

it('admits lane deletion and Host configuration channels in the browser', () => {
  for (const channel of CONFIGURATION_CHANNELS)
    expect(IPC_WEB[channel].kind, channel).toBe('remote-supported')
})

it('asks for a configure grant only after the explicit settings access request', async () => {
  const s = await setup()
  await s.ready(false)
  expect(s.grantRequests.length).toBeGreaterThan(0)
  expect(s.grantRequests.every((body) => !('configure' in body))).toBe(true)
  await expect(s.api.invoke('hosts:settingsAccess', s.hostId)).resolves.toBeUndefined()
  expect(s.grantRequests.at(-1)).toMatchObject({ configure: true })
  await s.ready(true)
  expect((await s.view())?.configurationSupported).toBe(true)
})

it('forgets the configure opt-in on sign-out', async () => {
  const s = await setup()
  await s.ready(false)
  await expect(s.api.invoke('hosts:settingsAccess', s.hostId)).resolves.toBeUndefined()
  await s.ready(true)
  await s.api.invoke('account:signOut')
  s.signIn()
  await s.api.invoke('account:signIn')
  const before = s.grantRequests.length
  await s.start()
  await s.ready(false)
  expect(s.grantRequests.length).toBeGreaterThan(before)
  expect(s.grantRequests.slice(before).every((body) => !('configure' in body))).toBe(true)
})

it('forgets the configure opt-in when the signed-in client changes', async () => {
  const s = await setup()
  await s.ready(false)
  await expect(s.api.invoke('hosts:settingsAccess', s.hostId)).resolves.toBeUndefined()
  await s.ready(true)
  s.newClient()
  const before = s.grantRequests.length
  await s.start()
  await vi.waitFor(() => expect(s.grantRequests.length).toBeGreaterThan(before))
  expect(s.grantRequests.slice(before).every((body) => !('configure' in body))).toBe(true)
})

it('rolls the opt-in back when control does not sign configuration access', async () => {
  const s = await setup({ control: 'old' })
  await s.ready(false)
  await expect(s.api.invoke('hosts:settingsAccess', s.hostId)).rejects.toThrow(
    'The control plane did not grant configuration access.',
  )
  const before = s.grantRequests.length
  await s.api.invoke('hosts:reconnect', s.hostId)
  await s.ready(false)
  await vi.waitFor(() => expect(s.grantRequests.length).toBeGreaterThan(before))
  expect(s.grantRequests.slice(before).every((body) => !('configure' in body))).toBe(true)
})

it('refuses Host settings while the connection lacks configuration authority', async () => {
  const s = await setup()
  await s.ready(false)
  await expect(s.api.invoke('hosts:settingsRead', s.hostId, 'agent')).rejects.toThrow(
    'Connect to this Host and enable configuration access first.',
  )
  await expect(s.api.invoke('hosts:settingsCheck', s.hostId)).rejects.toThrow(
    'Connect to this Host and enable configuration access first.',
  )
  await expect(s.api.invoke('hosts:claudeAccount', s.hostId, 'lane', 'default')).rejects.toThrow(
    'Connect to this Host and enable configuration access first.',
  )
})
