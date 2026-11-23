import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFakeHost, createLoopbackPair } from '@shared/host-protocol-testing'
import { HOST_LIMITS, parseClientFrame, type ClientFrame } from '@shared/host-protocol'
import type { GrantPayload } from '@shared/host-grant'
import {
  parseLocalCredential,
  type LocalCredentialPayload,
  type LocalIdentityFile,
} from '@phosphor/shared/host-local'
import type { OwnerKey } from '../daemon/owner-key'
import type { LocalHostSlot } from '../hosts/manager-state'
import {
  IDENTITY_RETRY_MS,
  LOCAL_MACHINE_LABEL,
  createLocalMachineConnection,
  startLocalMachine,
  type LocalMachinePorts,
} from './connection'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
const drain = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

const SOCKET = '/tmp/m2a-test/phosphor.sock'

function setup(options: { helloHostId?: string; ownerKey?: () => Promise<OwnerKey> } = {}) {
  const local = generateKeyPairSync('ed25519')
  const owner = generateKeyPairSync('ed25519')
  const machineId = randomUUID()
  const identity: LocalIdentityFile = {
    version: 1,
    machineId,
    createdAt: new Date().toISOString(),
    publicKey: local.publicKey.export({ format: 'jwk' }).x!,
  }
  const ownerKey: OwnerKey = {
    id: randomUUID(),
    label: 'Phosphor Desktop',
    publicKey: owner.publicKey.export({ format: 'jwk' }).x!,
    sign: (bytes) => sign(null, bytes, owner.privateKey),
  }
  const issued = new Set<string>()
  const credentials: LocalCredentialPayload[] = []
  const auths: Extract<ClientFrame, { type: 'auth' }>[] = []
  const claims = (payload: LocalCredentialPayload): GrantPayload => ({
    v: 1,
    iss: 'phosphor-local',
    kid: 'local',
    sub: 'owner',
    sid: randomUUID(),
    hostId: machineId,
    epoch: 1,
    client: payload.client,
    caps: ['sessions.read', 'sessions.control'],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: randomBytes(8).toString('hex'),
  })
  // The fake Host checks the owner credential the way the service's socket does.
  const host = createFakeHost({
    expectations: { iss: 'phosphor-local', hostId: machineId, owner: 'owner', epoch: 1 },
    id: randomUUID,
    epoch: () => randomBytes(8).toString('hex'),
    verify: () => false,
    verifyGrant: (token) => {
      const parsed = parseLocalCredential(token)
      if (!parsed.ok || parsed.value.payload.kind !== 'owner' || !parsed.value.signature)
        return null
      const { payload, payloadBytes, signature } = parsed.value
      const key = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: ownerKey.publicKey },
        format: 'jwk',
      })
      if (!verify(null, payloadBytes, key, signature) || !issued.delete(payload.nonce)) return null
      credentials.push(payload)
      return claims(payload)
    },
    sign: (bytes) => sign(null, bytes, local.privateKey),
  })
  const pairs: ReturnType<typeof createLoopbackPair>[] = []
  const hello = vi.fn(async (path: string, challenge: string) => {
    expect(path).toBe(SOCKET)
    expect(challenge).toMatch(/^[0-9a-f]{64}$/)
    const nonce = randomBytes(32).toString('hex')
    issued.add(nonce)
    return { hostId: options.helloHostId ?? machineId, nonce }
  })
  const open = vi.fn(async (path: string) => {
    expect(path).toBe(SOCKET)
    const pair = createLoopbackPair()
    pairs.push(pair)
    pair.server.onMessage((text) => {
      const parsed = parseClientFrame(text)
      if (parsed.ok && parsed.frame.type === 'auth') auths.push(parsed.frame)
    })
    host.attach(pair.server)
    return pair.client
  })
  const ports: LocalMachinePorts = {
    location: { kind: 'dev', socket: SOCKET, configDir: '/tmp/m2a-test/config' },
    ownerKey: options.ownerKey ?? (async () => ownerKey),
    changed: vi.fn(),
    transport: {
      hello,
      open,
      identity: vi.fn(() => identity),
      socketPath: (location) => (location.kind === 'dev' ? location.socket : null),
    },
  }
  return { identity, ownerKey, ports, hello, open, pairs, credentials, auths, machineId }
}

it('attests as the owner on a fresh nonce and reaches ready over the local endpoint', async () => {
  const t = setup()
  const connection = createLocalMachineConnection(t.identity, t.ports)
  await drain()
  expect(connection.snapshot()).toMatchObject({ state: 'ready', ownerLocal: false })
  expect(t.open).toHaveBeenCalledOnce()
  expect(t.credentials).toEqual([
    expect.objectContaining({
      kind: 'owner',
      machineId: t.machineId,
      client: { id: t.ownerKey.id, label: t.ownerKey.label },
    }),
  ])
  expect(t.auths[0]?.grant.startsWith('phosphor-local.v1.')).toBe(true)
  expect(t.auths[0]?.challenge).toMatch(/^[0-9a-f]{64}$/)
  connection.close()
})

it('renews with a new nonce and no challenge before the credential expires', async () => {
  const t = setup()
  const connection = createLocalMachineConnection(t.identity, t.ports)
  await drain()
  await vi.advanceTimersByTimeAsync((300 - HOST_LIMITS.renewBeforeSec) * 1000)
  await drain()
  expect(t.hello).toHaveBeenCalledTimes(2)
  expect(t.credentials).toHaveLength(2)
  expect(t.credentials[0]?.nonce).not.toBe(t.credentials[1]?.nonce)
  expect(t.auths[1]?.challenge).toBeUndefined()
  expect(connection.snapshot().state).toBe('ready')
  connection.close()
})

it('reconnects within a second after the service closes with 1001', async () => {
  const t = setup()
  const connection = createLocalMachineConnection(t.identity, t.ports)
  await drain()
  t.pairs[0]?.server.close(1001, 'Lanes started')
  await drain()
  expect(connection.snapshot().state).toBe('reconnecting')
  await vi.advanceTimersByTimeAsync(1000)
  await drain()
  expect(t.open).toHaveBeenCalledTimes(2)
  expect(t.hello).toHaveBeenCalledTimes(2)
  expect(connection.snapshot().state).toBe('ready')
  connection.close()
})

it('never opens the stream when the socket answers for another machine', async () => {
  const t = setup({ helloHostId: randomUUID() })
  const connection = createLocalMachineConnection(t.identity, t.ports)
  await drain()
  expect(t.open).not.toHaveBeenCalled()
  expect(connection.snapshot()).toMatchObject({ state: 'reconnecting', lastError: 'offline' })
  connection.close()
})

it('stays off the socket and retries while the owner key is unavailable', async () => {
  const t = setup({ ownerKey: () => Promise.reject(new Error('Protected storage is unavailable')) })
  const connection = createLocalMachineConnection(t.identity, t.ports)
  await drain()
  expect(t.open).not.toHaveBeenCalled()
  expect(connection.snapshot()).toMatchObject({ state: 'reconnecting', lastError: 'offline' })
  connection.close()
})

it('waits for the service identity, then attaches one slot; stop detaches it', async () => {
  const t = setup()
  const identity = vi.fn<() => LocalIdentityFile | null>().mockReturnValueOnce(null)
  identity.mockReturnValue(t.identity)
  const attach = vi.fn<(slot: LocalHostSlot | null) => void>()
  const running = startLocalMachine({
    ...t.ports,
    transport: { ...t.ports.transport!, identity },
    attach,
  })
  expect(attach).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(IDENTITY_RETRY_MS)
  expect(identity).toHaveBeenCalledWith('/tmp/m2a-test/config', undefined)
  expect(attach).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ hostId: t.machineId, label: LOCAL_MACHINE_LABEL }),
  )
  running.stop()
  expect(attach).toHaveBeenLastCalledWith(null)
  await vi.advanceTimersByTimeAsync(IDENTITY_RETRY_MS * 3)
  expect(attach).toHaveBeenCalledTimes(2)
})
