import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseGrantIssueResponse } from './control-api'
import {
  HOST_AGENT,
  HOST_UNIT,
  LOCAL_CREDENTIAL_PREFIX,
  LOCAL_LIMITS,
  chooseLocalSocket,
  encodeLocalCredential,
  hostConfigDirectory,
  hostStateDirectory,
  isLocalEndpoint,
  localEndpoint,
  localGrantIssueResponse,
  localHelloNonce,
  localSocketCandidates,
  parseLocalCredential,
  parseLocalIdentityFile,
  parseLocalRunFile,
  parseOwnerClientsFile,
  type LocalCredentialPayload,
} from './host-local'
import { GRANT_PREFIX, encodeBase64url } from './host-grant'

const MACHINE = '00000000-0000-4000-8000-000000000001'
const CLIENT = '00000000-0000-4000-8000-000000000002'
const NONCE = 'ab'.repeat(32)
const owner: LocalCredentialPayload = {
  v: 1,
  kind: 'owner',
  machineId: MACHINE,
  client: { id: CLIENT, label: 'Desktop' },
  nonce: NONCE,
  iat: 1000,
}
const local: LocalCredentialPayload = { ...owner, kind: 'local', lane: 'session-1' }
const keys = generateKeyPairSync('ed25519')
const signer = (bytes: Uint8Array) => sign(null, bytes, keys.privateKey)
const publicKey = encodeBase64url(
  new Uint8Array(Buffer.from(keys.publicKey.export({ format: 'jwk' }).x ?? '', 'base64url')),
)

describe('local credentials', () => {
  it('signs an owner credential and verifies over the payload bytes', () => {
    const token = encodeLocalCredential(owner, signer)
    expect(token.startsWith(LOCAL_CREDENTIAL_PREFIX)).toBe(true)
    const parsed = parseLocalCredential(token)
    if (!parsed.ok || !parsed.value.signature) throw new Error('expected a signed credential')
    expect(parsed.value.payload).toStrictEqual(owner)
    expect(verify(null, parsed.value.payloadBytes, keys.publicKey, parsed.value.signature)).toBe(
      true,
    )
  })

  it('leaves a local credential unsigned and keeps its lane', () => {
    const token = encodeLocalCredential(local)
    expect(token.endsWith('.')).toBe(true)
    expect(parseLocalCredential(token)).toMatchObject({
      ok: true,
      value: { payload: local, signature: null },
    })
  })

  it('refuses the wrong signing, owner lanes, grants and malformed payloads', () => {
    expect(() => encodeLocalCredential(owner)).toThrow()
    expect(() => encodeLocalCredential(local, signer)).toThrow()
    expect(() => encodeLocalCredential({ ...owner, lane: 'x' }, signer)).toThrow()
    const unsigned = encodeLocalCredential(local).replace(/\.$/, '')
    for (const token of [`${GRANT_PREFIX}a.b`, unsigned, `${LOCAL_CREDENTIAL_PREFIX}e30.`])
      expect(parseLocalCredential(token).ok, token).toBe(false)
    const forged = encodeLocalCredential(owner, signer).replace(/\.[^.]+$/, '.')
    expect(parseLocalCredential(forged)).toStrictEqual({ ok: false, reason: 'signature' })
  })
})

describe('local socket path', () => {
  const base = { uid: 501, stateHash16: '0123456789abcdef' }
  it('prefers the runtime folder on Linux, then the state folder, then /tmp', () => {
    expect(
      localSocketCandidates({
        ...base,
        platform: 'linux',
        stateDir: '/s/',
        runtimeDir: '/run/user/501',
      }),
    ).toStrictEqual([
      '/run/user/501/phosphor-host/phosphor.sock',
      '/s/run/phosphor.sock',
      '/tmp/phosphor-501/0123456789abcdef.sock',
    ])
    expect(
      localSocketCandidates({ ...base, platform: 'darwin', stateDir: '/s', runtimeDir: '/r' }),
    ).toHaveLength(2)
  })

  it('chooses by UTF-8 bytes, never by string length', () => {
    const fits = `/${'a'.repeat(LOCAL_LIMITS.socketPathBytes - 1)}`
    expect(chooseLocalSocket([fits, '/tmp/x.sock'])).toBe(fits)
    expect(chooseLocalSocket([`${fits}a`, '/tmp/x.sock'])).toBe('/tmp/x.sock')
    // Within the limit in characters, one byte over it in UTF-8: "é" is two bytes.
    const accented = `/${'a'.repeat(LOCAL_LIMITS.socketPathBytes - 3)}é`
    expect(accented.length).toBe(LOCAL_LIMITS.socketPathBytes - 1)
    expect(chooseLocalSocket([`${accented}a`])).toBeNull()
  })
})

describe('the grant Desktop builds for its own daemon', () => {
  it('uses the machine id, a synthetic endpoint and the raw public key', () => {
    const credential = encodeLocalCredential(owner, signer)
    const response = localGrantIssueResponse({
      machineId: MACHINE,
      credential,
      expiresAt: '2026-01-01T00:05:00.000Z',
      publicKey,
    })
    expect(response.host).toStrictEqual({
      id: MACHINE,
      endpoint: `phosphor-local:${MACHINE}`,
      publicKey,
    })
    expect(isLocalEndpoint(localEndpoint(MACHINE))).toBe(true)
    expect(isLocalEndpoint('https://stark.tailnet.ts.net')).toBe(false)
    // Never a control grant: the network grant parser refuses it.
    expect(parseGrantIssueResponse(response).ok).toBe(false)
  })

  it('reads the nonce from the socket hello', () => {
    expect(localHelloNonce({ hello: {}, proof: 'p', nonce: NONCE })).toBe(NONCE)
    expect(localHelloNonce({ hello: {}, proof: 'p' })).toBeNull()
  })
})

describe('sidecar files', () => {
  it('reads local.json, local-identity.json and owner-clients.json', () => {
    const run = {
      version: 1,
      pid: 42,
      hostVersion: '1.2.3',
      machineId: MACHINE,
      socket: '/s/run/phosphor.sock',
      startedAt: 1,
      localReadyAt: 2,
    }
    expect(parseLocalRunFile(run)).toStrictEqual(run)
    expect(parseLocalRunFile({ ...run, socket: `/${'a'.repeat(200)}` })).toBeNull()
    const identity = { version: 1, machineId: MACHINE, createdAt: 'now', publicKey }
    expect(parseLocalIdentityFile(identity)).toStrictEqual(identity)
    expect(parseLocalIdentityFile({ ...identity, publicKey: undefined })).toBeNull()
    const client = { id: CLIENT, label: 'Desktop', publicKey, addedAt: 'now' }
    expect(parseOwnerClientsFile({ version: 1, clients: [client] })).toStrictEqual({
      version: 1,
      clients: [client],
    })
    expect(parseOwnerClientsFile({ version: 1, clients: [client, client] })).toBeNull()
    const many = Array.from({ length: LOCAL_LIMITS.ownerClients + 1 }, () => client)
    expect(parseOwnerClientsFile({ version: 1, clients: many })).toBeNull()
  })
})

describe('Host service names', () => {
  it('are the names every installed Host service already uses', () => {
    expect(HOST_AGENT).toBe('com.saccolabs.phosphor-host')
    expect(HOST_UNIT).toBe('phosphor-host.service')
  })
})

describe('Host folders', () => {
  const envs = [
    {},
    { XDG_CONFIG_HOME: '/xdg/config', XDG_STATE_HOME: '/xdg/state' },
    { XDG_CONFIG_HOME: '/xdg/config/', XDG_STATE_HOME: '/xdg//state/' },
    { XDG_CONFIG_HOME: '/a/./b/../config', XDG_STATE_HOME: '/../state' },
    { XDG_CONFIG_HOME: 'relative', XDG_STATE_HOME: 'relative' },
    { XDG_CONFIG_HOME: '', XDG_STATE_HOME: '' },
  ]
  it.each(
    envs.flatMap((env) =>
      ['/Users/someone', '/home/me/', '/', 'rel/home'].map((home) => [env, home] as const),
    ),
  )('match path.join for %j with home %s', (env, home) => {
    const xdg = (value: string | undefined, fallback: string) =>
      value && isAbsolute(value) ? value : join(home, fallback)
    expect(hostConfigDirectory(env, home)).toBe(
      join(xdg(env.XDG_CONFIG_HOME, '.config'), 'phosphor-host'),
    )
    expect(hostStateDirectory(env, home)).toBe(
      join(xdg(env.XDG_STATE_HOME, join('.local', 'state')), 'phosphor-host'),
    )
  })
})
