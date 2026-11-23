import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OWNER_LOCK_FILE } from '@phosphor/shared/host-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireOwnerLock,
  isOwnerLockHolderLive,
  OwnerLockUnavailable,
  readOwnerLock,
} from './owner-lock'
import { OwnerLockBusy, type OwnerLockPorts, type OwnerLockRecord } from './types'

let agentDir: string
let lockPath: string
/** Fake processes: a pid is alive while it has a start time here. */
let processes: Map<number, string>
const portsFor = (pid: number): OwnerLockPorts => ({
  pid,
  isAlive: (other) => processes.has(other),
  processStart: async (other) => processes.get(other) ?? null,
})
const holder = (overrides: Partial<OwnerLockRecord> = {}): OwnerLockRecord => ({
  version: 1,
  owner: 'daemon',
  pid: 456,
  processStart: 'start-456',
  token: 'a'.repeat(64),
  startedAt: '2026-11-22T22:00:00.000Z',
  program: 'phosphor',
  ...overrides,
})
const writeHolder = (record: object | string) =>
  writeFile(lockPath, typeof record === 'string' ? record : JSON.stringify(record) + '\n', {
    mode: 0o600,
  })

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'owner-lock-'))
  await chmod(agentDir, 0o755)
  lockPath = join(agentDir, OWNER_LOCK_FILE)
  processes = new Map([
    [100, 'start-100'],
    [200, 'start-200'],
  ])
})
afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('R7: one owner per pi agent folder', () => {
  it('publishes a complete private record in pi agent folder, which need not be 0700', async () => {
    const lock = await acquireOwnerLock(agentDir, 'desktop', portsFor(100), { program: 'Phosphor' })
    expect(lock.record).toEqual({
      version: 1,
      owner: 'desktop',
      pid: 100,
      processStart: 'start-100',
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
      startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      program: 'Phosphor',
    })
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(lock.record)
    expect((await lstat(lockPath)).mode & 0o777).toBe(0o600)
    expect(await readdir(agentDir)).toEqual([OWNER_LOCK_FILE])
    expect(await readOwnerLock(agentDir)).toEqual(lock.record)
    await lock.release()
    expect(await readdir(agentDir)).toEqual([])
    expect((await stat(agentDir)).mode & 0o777).toBe(0o755)
  })

  it('two live holders cannot both acquire, whichever role asks', async () => {
    const first = await acquireOwnerLock(agentDir, 'desktop', portsFor(100))
    const before = await readFile(lockPath, 'utf8')
    for (const owner of ['daemon', 'desktop'] as const) {
      const attempt = acquireOwnerLock(agentDir, owner, portsFor(200))
      await expect(attempt).rejects.toBeInstanceOf(OwnerLockBusy)
      await expect(attempt).rejects.toMatchObject({ holder: first.record })
    }
    expect(await readFile(lockPath, 'utf8')).toBe(before)
    expect(await readdir(agentDir)).toEqual([OWNER_LOCK_FILE])
    await first.release()
    const second = await acquireOwnerLock(agentDir, 'daemon', portsFor(200))
    expect(second.record).toMatchObject({ owner: 'daemon', pid: 200 })
    await second.release()
  })

  it('reclaims a dead holder', async () => {
    await writeHolder(holder())
    const lock = await acquireOwnerLock(agentDir, 'daemon', portsFor(100))
    expect(await readOwnerLock(agentDir)).toEqual(lock.record)
    await lock.release()
    expect(await readdir(agentDir)).toEqual([])
  })

  it('reclaims a reused pid: alive, but started at another time', async () => {
    processes.set(456, 'start-456-again')
    await writeHolder(holder())
    const lock = await acquireOwnerLock(agentDir, 'desktop', portsFor(100))
    expect(lock.record.pid).toBe(100)
    await lock.release()
  })

  it.each([
    ['the same start time', 'start-456', 'start-456'],
    ['an unreadable current start time', 'start-456', null],
    ['no recorded start time', null, 'start-456'],
  ] as const)('never steals from a live holder with %s', async (_case, recorded, current) => {
    processes.set(456, current as string)
    const ports = {
      ...portsFor(100),
      processStart: async (pid: number) => (pid === 456 ? current : 'start-100'),
    }
    await writeHolder(holder({ processStart: recorded }))
    const before = await readFile(lockPath, 'utf8')
    await expect(acquireOwnerLock(agentDir, 'desktop', ports)).rejects.toMatchObject({
      constructor: OwnerLockBusy,
      holder: { pid: 456, owner: 'daemon', processStart: recorded },
    })
    expect(await readFile(lockPath, 'utf8')).toBe(before)
  })

  it('refuses without changing the lock when liveness cannot be checked', async () => {
    await writeHolder(holder())
    const ports: OwnerLockPorts = {
      ...portsFor(100),
      isAlive: () => {
        throw new Error('Could not check the owner lock holder.')
      },
    }
    await expect(acquireOwnerLock(agentDir, 'desktop', ports)).rejects.toThrow(
      'Could not check the owner lock holder.',
    )
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(holder())
  })

  it('rechecks liveness under the gate and keeps a holder that now looks alive', async () => {
    await writeHolder(holder())
    let checks = 0
    const ports: OwnerLockPorts = {
      ...portsFor(100),
      isAlive: (pid) => pid === 456 && ++checks > 2,
    }
    await expect(acquireOwnerLock(agentDir, 'daemon', ports)).rejects.toBeInstanceOf(OwnerLockBusy)
    expect(checks).toBe(4)
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(holder())
    expect(await readdir(agentDir)).toEqual([OWNER_LOCK_FILE])
  })

  it.each([
    ['malformed JSON', '{'],
    ['an unknown version', holder({ version: 2 as 1 })],
    ['an unknown owner', holder({ owner: 'routine' as 'daemon' })],
    ['a bad token', holder({ token: 'A'.repeat(64) })],
    ['a zero pid', holder({ pid: 0 })],
    ['a non-ISO start', holder({ startedAt: 'yesterday' })],
    ['a numeric process start', { ...holder(), processStart: 7 }],
  ])('reclaims an invalid lock with %s, which no holder ever wrote', async (_case, record) => {
    processes.set(456, 'start-456')
    await writeHolder(record)
    expect(await readOwnerLock(agentDir)).toBeNull()
    const lock = await acquireOwnerLock(agentDir, 'daemon', portsFor(100))
    expect(lock.record.pid).toBe(100)
    await lock.release()
  })

  it('reclaims a symlinked lock without following or touching its target', async () => {
    const target = join(agentDir, 'target')
    await writeFile(target, JSON.stringify(holder({ pid: 200, processStart: 'start-200' })), {
      mode: 0o600,
    })
    await symlink(target, lockPath)
    expect(await readOwnerLock(agentDir)).toBeNull()
    const lock = await acquireOwnerLock(agentDir, 'desktop', portsFor(100))
    expect((await lstat(lockPath)).isFile()).toBe(true)
    await lock.release()
    expect(JSON.parse(await readFile(target, 'utf8')).pid).toBe(200)
    expect(await readdir(agentDir)).toEqual(['target'])
  })

  it('release removes only its own token', async () => {
    const lock = await acquireOwnerLock(agentDir, 'desktop', portsFor(100))
    await rm(lockPath)
    await writeHolder(holder({ pid: 200, processStart: 'start-200' }))
    await lock.release()
    expect(JSON.parse(await readFile(lockPath, 'utf8')).pid).toBe(200)
    await lock.release()
    expect(await readdir(agentDir)).toEqual([OWNER_LOCK_FILE])
  })
})

describe('owner lock folder and refusals', () => {
  it('creates a missing agent folder', async () => {
    const nested = join(agentDir, 'pi', 'agent')
    const lock = await acquireOwnerLock(nested, 'daemon', portsFor(100))
    expect(await readdir(nested)).toEqual([OWNER_LOCK_FILE])
    await lock.release()
  })

  it('refuses an agent folder owned by another user, before publishing', async () => {
    const uid = process.getuid?.()
    if (uid === undefined) return
    await expect(
      acquireOwnerLock(agentDir, 'daemon', portsFor(100), { uid: uid + 1 }),
    ).rejects.toThrow(`pi's agent folder ${agentDir} is not a folder this user owns.`)
    expect(await readdir(agentDir)).toEqual([])
  })

  it('refuses an agent folder path that is a file', async () => {
    const file = join(agentDir, 'file')
    await writeFile(file, '')
    await expect(acquireOwnerLock(file, 'daemon', portsFor(100))).rejects.toThrow()
  })

  it('refuses a directory at the lock path with a removal instruction', async () => {
    await mkdir(lockPath)
    const attempt = acquireOwnerLock(agentDir, 'daemon', portsFor(100))
    await expect(attempt).rejects.toBeInstanceOf(OwnerLockUnavailable)
    await expect(attempt).rejects.toMatchObject({
      reason: 'directory',
      message: `Remove the folder ${lockPath}, then start Phosphor again.`,
    })
    expect(await readdir(agentDir)).toEqual([OWNER_LOCK_FILE])
  })

  it('never clears an old recovery gate, and names it', async () => {
    await writeHolder(holder())
    const gate = `${lockPath}-recovery`
    await mkdir(gate, { mode: 0o700 })
    const instant = new Date('2026-11-22T00:00:00.000Z')
    await utimes(gate, instant, instant)
    const waits: number[] = []
    const attempt = acquireOwnerLock(agentDir, 'daemon', portsFor(100), {
      now: () => instant.getTime() + 86_400_000,
      wait: async (ms) => void waits.push(ms),
    })
    await expect(attempt).rejects.toMatchObject({
      constructor: OwnerLockUnavailable,
      reason: 'gate-stuck',
      message: `A crashed Phosphor process left ${gate}. If no Phosphor is starting, remove it and retry.`,
    })
    expect(waits).toEqual(Array.from({ length: 20 }, () => 50))
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(holder())
    await rmdir(gate)
  })

  it('reports a busy recovery gate as contended', async () => {
    await writeHolder(holder())
    await mkdir(`${lockPath}-recovery`, { mode: 0o700 })
    await expect(
      acquireOwnerLock(agentDir, 'daemon', portsFor(100), { wait: async () => {} }),
    ).rejects.toMatchObject({ constructor: OwnerLockUnavailable, reason: 'contended' })
  })
})

describe('reading the owner lock', () => {
  it('reads nothing when no lock exists', async () => {
    expect(await readOwnerLock(agentDir)).toBeNull()
    expect(await readOwnerLock(join(agentDir, 'missing'))).toBeNull()
  })

  it('reads a stale holder as written; liveness is a separate question', async () => {
    await writeHolder(holder())
    expect(await readOwnerLock(agentDir)).toEqual(holder())
    expect(await isOwnerLockHolderLive(holder(), portsFor(100))).toBe(false)
    processes.set(456, 'start-456')
    expect(await isOwnerLockHolderLive(holder(), portsFor(100))).toBe(true)
    processes.set(456, 'other')
    expect(await isOwnerLockHolderLive(holder(), portsFor(100))).toBe(false)
    expect(await isOwnerLockHolderLive(holder({ processStart: null }), portsFor(100))).toBe(true)
  })

  it('does not read a lock another user could have written', async () => {
    await writeHolder(holder())
    await chmod(lockPath, 0o644)
    expect(await readOwnerLock(agentDir)).toBeNull()
  })
})
