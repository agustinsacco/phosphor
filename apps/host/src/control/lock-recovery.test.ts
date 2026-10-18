import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  acquireRecoveryGate,
  LockBusy,
  parseLock,
  reclaimLock,
  releaseIdentityLock,
  snapshotLock,
  type LockState,
} from './lock-recovery'

let state: LockState
const token = 'a'.repeat(64)
const record = { pid: 456, token, startedAt: '2026-10-10T00:00:00.000Z' }
const text = JSON.stringify(record)
beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-lock-recovery-'))
  state = {
    directory,
    path: join(directory, '.lock'),
    gatePath: join(directory, '.lock-recovery'),
    name: '.lock',
    uid: process.getuid?.(),
    token,
    ports: { pid: 123, isAlive: () => false },
  }
})
afterEach(async () => {
  await rm(state.directory, { recursive: true, force: true })
})

it('parses only the pid and token from a valid snapshot', () => {
  expect(parseLock(text)).toEqual({ pid: 456, token })
  expect(parseLock(JSON.stringify({ ...record, pid: 2147483647 }))).toEqual({
    pid: 2147483647,
    token,
  })
})

it.each([
  '{',
  'null',
  '[]',
  JSON.stringify({ ...record, pid: 0 }),
  JSON.stringify({ ...record, pid: -1 }),
  JSON.stringify({ ...record, pid: 1.5 }),
  JSON.stringify({ ...record, pid: 2147483648 }),
  JSON.stringify({ ...record, pid: '456' }),
  JSON.stringify({ ...record, token: 'A'.repeat(64) }),
  JSON.stringify({ ...record, token: 'a'.repeat(63) }),
  JSON.stringify({ ...record, token: 123 }),
  JSON.stringify({ ...record, startedAt: 'yesterday' }),
  JSON.stringify({ pid: 456, token }),
])('treats invalid snapshot text %s as recoverable', (invalid) => {
  expect(parseLock(invalid)).toBeNull()
})

it('acquires the gate immediately without waiting', async () => {
  const wait = vi.fn(async () => {})
  state.ports.wait = wait
  await acquireRecoveryGate(state)
  expect(wait).not.toHaveBeenCalled()
  expect((await lstat(state.gatePath)).isDirectory()).toBe(true)
})

it('can acquire the gate on the twenty-first attempt after twenty 50ms waits', async () => {
  await mkdir(state.gatePath)
  let waits = 0
  state.ports.wait = async (ms) => {
    expect(ms).toBe(50)
    if (++waits === 20) await rmdir(state.gatePath)
  }
  await acquireRecoveryGate(state)
  expect(waits).toBe(20)
  expect((await lstat(state.gatePath)).isDirectory()).toBe(true)
})

it.each([30_000, 30_001])(
  'uses age %s only for a diagnostic after all gate attempts',
  async (age) => {
    await mkdir(state.gatePath)
    const instant = new Date('2026-10-10T00:00:00.000Z')
    await utimes(state.gatePath, instant, instant)
    state.ports.now = () => instant.getTime() + age
    const wait = vi.fn(async (_ms: number) => {})
    state.ports.wait = wait
    const attempt = acquireRecoveryGate(state)
    await expect(attempt).rejects.toBeInstanceOf(LockBusy)
    await expect(attempt).rejects.toThrow(
      age > 30_000
        ? 'A crashed phosphor login or logout left identity/.lock-recovery. If none is running, remove it and retry.'
        : 'Another phosphor login or logout is running.',
    )
    expect(wait.mock.calls).toEqual(Array.from({ length: 20 }, () => [50]))
    expect((await lstat(state.gatePath)).isDirectory()).toBe(true)
  },
)

it('reports busy without following a dangling symlink gate on its last attempt', async () => {
  await mkdir(state.gatePath)
  let waits = 0
  state.ports.wait = async () => {
    if (++waits === 20) {
      await rmdir(state.gatePath)
      await symlink(join(state.directory, 'missing-parent', 'gate'), state.gatePath)
    }
  }
  // A dangling symlink still occupies the gate and is never followed or deleted.
  await expect(acquireRecoveryGate(state)).rejects.toBeInstanceOf(LockBusy)
  expect((await lstat(state.gatePath)).isSymbolicLink()).toBe(true)
})

it('does not wait or translate a non-EEXIST gate error', async () => {
  state.gatePath = join(state.directory, 'absent', 'gate')
  const wait = vi.fn(async () => {})
  state.ports.wait = wait
  await expect(acquireRecoveryGate(state)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(wait).not.toHaveBeenCalled()
})

it('distinguishes missing, malformed and valid lock snapshots', async () => {
  expect(await snapshotLock(state)).toBeNull()
  await writeFile(state.path, '{', { mode: 0o600 })
  expect(await snapshotLock(state)).toMatchObject({
    lock: null,
    info: { ino: (await lstat(state.path)).ino },
  })
  await writeFile(state.path, text, { mode: 0o600 })
  expect(await snapshotLock(state)).toMatchObject({ lock: { pid: 456, token } })
})

it('retains the lstat identity of an unsafe symlink without following it', async () => {
  const target = join(state.directory, 'target')
  await writeFile(target, text, { mode: 0o600 })
  await symlink(target, state.path)
  const snapshot = await snapshotLock(state)
  expect(snapshot?.lock).toBeNull()
  expect(snapshot?.info.isSymbolicLink()).toBe(true)
  expect(snapshot?.info.ino).toBe((await lstat(state.path)).ino)
})

it('uses the descriptor identity rather than the initial lstat for a readable lock', async () => {
  await writeFile(state.path, text, { mode: 0o600 })
  const actual = await lstat(state.path)
  state.ports.lstat = async () => Object.assign(await lstat(state.path), { ino: actual.ino + 1 })
  expect((await snapshotLock(state))?.info.ino).toBe(actual.ino)
})

it.each(['dev', 'ino', 'token', 'absent-stale', 'alive'] as const)(
  'keeps a lock when the under-gate comparison differs by %s',
  async (difference) => {
    await writeFile(state.path, text, { mode: 0o600 })
    const stale = await snapshotLock(state)
    if (!stale?.lock) throw new Error('Expected a parsed stale lock')
    if (difference === 'dev' || difference === 'ino') stale.info[difference]++
    if (difference === 'token') stale.lock.token = 'b'.repeat(64)
    if (difference === 'alive') state.ports.isAlive = () => true
    await reclaimLock(state, difference === 'absent-stale' ? null : stale)
    expect(await readFile(state.path, 'utf8')).toBe(text)
    expect(await readdir(state.directory)).toEqual(['.lock'])
  },
)

it.each(['valid', 'malformed'] as const)(
  'reclaims an unchanged dead %s lock under its gate',
  async (kind) => {
    await writeFile(state.path, kind === 'valid' ? text : '{', { mode: 0o600 })
    await reclaimLock(state, await snapshotLock(state))
    expect(await readdir(state.directory)).toEqual([])
  },
)

it('leaves the gate clean when the current lock disappeared', async () => {
  await reclaimLock(state, null)
  expect(await readdir(state.directory)).toEqual([])
})

it('cleans its gate even when a directory replaces the lock during recovery', async () => {
  await mkdir(state.path)
  await expect(reclaimLock(state, null)).rejects.toThrow('Remove the directory identity/.lock')
  expect(await readdir(state.directory)).toEqual(['.lock'])
})

it.each(['own', 'other', 'malformed', 'missing'] as const)(
  'releases only its own parsed token (%s)',
  async (kind) => {
    if (kind !== 'missing')
      await writeFile(
        state.path,
        kind === 'malformed'
          ? '{}'
          : JSON.stringify({ ...record, token: kind === 'own' ? token : 'b'.repeat(64) }),
        { mode: 0o600 },
      )
    await releaseIdentityLock(state)
    expect(await readdir(state.directory)).toEqual(
      kind === 'own' || kind === 'missing' ? [] : ['.lock'],
    )
  },
)

it('does not remove a gate owned by another process when release is refused', async () => {
  await writeFile(state.path, text, { mode: 0o600 })
  await mkdir(state.gatePath)
  state.ports.wait = async () => {}
  await expect(releaseIdentityLock(state)).rejects.toBeInstanceOf(LockBusy)
  expect(await readFile(state.path, 'utf8')).toBe(text)
  expect((await lstat(state.gatePath)).isDirectory()).toBe(true)
})

it('shares the public LockBusy constructor with the acquisition facade', async () => {
  const facade = await import('./lock')
  expect(facade.LockBusy).toBe(LockBusy)
  expect(new facade.LockBusy(456).message).toBe(
    'Another phosphor login or logout is running (pid 456).',
  )
})
