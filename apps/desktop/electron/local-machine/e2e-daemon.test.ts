import { generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import {
  E2E_OWNER_KEY_ENV,
  e2eDaemonAccess,
  readE2eOwnerKey,
  type E2eDaemonInput,
} from './e2e-daemon'
import { LOCAL_DAEMON_CONFIG_ENV, LOCAL_DAEMON_SOCKET_ENV } from './transport'

vi.mock('electron', () => ({ app: { isPackaged: true } }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))

const uid = process.getuid?.()
let scratch: string
let outside: string

function pair() {
  const { privateKey } = generateKeyPairSync('ed25519')
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    raw: privateKey.export({ format: 'jwk' }).x!,
    privateKey,
  }
}

/** A fixture daemon's config folder with one paired owner, and that owner's PEM. */
function world(root: string) {
  const config = join(root, 'config')
  const owner = pair()
  const id = randomUUID()
  rmSync(config, { recursive: true, force: true })
  mkdirSync(config, { mode: 0o700 })
  writeFileSync(
    join(config, HOST_SIDECARS.ownerClients),
    JSON.stringify({
      version: 1,
      clients: [{ id, label: 'Phosphor Desktop', publicKey: owner.raw, addedAt: 'now' }],
    }),
    { mode: 0o600 },
  )
  const key = join(root, 'owner-key.pem')
  writeFileSync(key, owner.pem, { mode: 0o600 })
  return { config, key, id, owner }
}

function input(env: NodeJS.ProcessEnv, patch: Partial<E2eDaemonInput> = {}): E2eDaemonInput {
  return {
    isPackaged: false,
    env,
    home: join(scratch, 'home'),
    uid,
    scratchRoots: [scratch],
    ...patch,
  }
}

function fullEnv(w: ReturnType<typeof world>): NodeJS.ProcessEnv {
  return {
    [LOCAL_DAEMON_SOCKET_ENV]: join(scratch, 'd.sock'),
    [LOCAL_DAEMON_CONFIG_ENV]: w.config,
    [E2E_OWNER_KEY_ENV]: w.key,
    PHOSPHOR_TEST_USER_DATA: join(scratch, 'user-data'),
  }
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-daemon-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-daemon-outside-')))
})
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('e2eDaemonAccess', () => {
  it('is inert and silent in a packaged app, even with every variable set', () => {
    const env = fullEnv(world(scratch))
    expect(e2eDaemonAccess(input(env, { isPackaged: true }))).toEqual({ on: false, reason: null })
  })

  it('is inert and silent when no hook variable is set', () => {
    world(scratch)
    expect(e2eDaemonAccess(input({ PHOSPHOR_TEST_USER_DATA: '1' }))).toEqual({
      on: false,
      reason: null,
    })
  })

  it.each([
    LOCAL_DAEMON_SOCKET_ENV,
    LOCAL_DAEMON_CONFIG_ENV,
    E2E_OWNER_KEY_ENV,
    'PHOSPHOR_TEST_USER_DATA',
  ])('is inert and says why when %s is missing', (name) => {
    const env = fullEnv(world(scratch))
    delete env[name]
    const decision = e2eDaemonAccess(input(env))
    expect(decision.on).toBe(false)
    expect(!decision.on && decision.reason).toContain(name)
  })

  it('refuses an owner key outside the scratch folders', () => {
    const w = world(scratch)
    const away = join(outside, 'owner-key.pem')
    writeFileSync(away, w.owner.pem, { mode: 0o600 })
    const decision = e2eDaemonAccess(input({ ...fullEnv(w), [E2E_OWNER_KEY_ENV]: away }))
    expect(decision).toEqual({ on: false, reason: expect.stringContaining(E2E_OWNER_KEY_ENV) })
  })

  it('refuses a scratch symlink to a key outside scratch', () => {
    const w = world(scratch)
    const away = join(outside, 'owner-key.pem')
    writeFileSync(away, w.owner.pem, { mode: 0o600 })
    const link = join(scratch, 'linked.pem')
    symlinkSync(away, link)
    const decision = e2eDaemonAccess(input({ ...fullEnv(w), [E2E_OWNER_KEY_ENV]: link }))
    expect(decision.on).toBe(false)
  })

  it('refuses an owner key other users can read', () => {
    const w = world(scratch)
    chmodSync(w.key, 0o644)
    expect(e2eDaemonAccess(input(fullEnv(w))).on).toBe(false)
  })

  it('refuses a config folder outside the scratch folders', () => {
    const w = world(scratch)
    const env = { ...fullEnv(w), [LOCAL_DAEMON_CONFIG_ENV]: outside }
    expect(e2eDaemonAccess(input(env))).toEqual({
      on: false,
      reason: expect.stringContaining(LOCAL_DAEMON_CONFIG_ENV),
    })
  })

  it('refuses a socket or config under the real home folders', () => {
    const w = world(scratch)
    const env = { ...fullEnv(w), [LOCAL_DAEMON_SOCKET_ENV]: join(scratch, 'home/.local/d.sock') }
    expect(e2eDaemonAccess(input(env)).on).toBe(false)
  })

  it('decides daemon access with the dev location and the paired owner key', async () => {
    const w = world(scratch)
    const decision = e2eDaemonAccess(input(fullEnv(w)))
    if (!decision.on) throw new Error(`expected on: ${decision.reason}`)
    expect(decision.access.location).toEqual({
      kind: 'dev',
      socket: join(scratch, 'd.sock'),
      configDir: w.config,
    })
    const key = await decision.access.ownerKey()
    expect(key).toMatchObject({ id: w.id, label: 'Phosphor Desktop', publicKey: w.owner.raw })
    const bytes = Buffer.from('payload')
    expect(verify(null, bytes, w.owner.privateKey, Buffer.from(key.sign(bytes)))).toBe(true)
  })
})

describe('readE2eOwnerKey', () => {
  it('rejects through ownerKey when the key is not paired with the daemon', async () => {
    const w = world(scratch)
    writeFileSync(w.key, pair().pem, { mode: 0o600 })
    const decision = e2eDaemonAccess(input(fullEnv(w)))
    if (!decision.on) throw new Error('expected on')
    await expect(decision.access.ownerKey()).rejects.toThrow('not paired')
  })

  it('refuses an owner-clients.json other users can read', () => {
    const w = world(scratch)
    chmodSync(join(w.config, HOST_SIDECARS.ownerClients), 0o644)
    expect(() => readE2eOwnerKey(w.key, w.config, uid)).toThrow('owner-clients.json')
  })
})
