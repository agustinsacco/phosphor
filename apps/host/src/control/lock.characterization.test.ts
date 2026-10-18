import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IdentityFailure } from './identity'
import { acquireIdentityLock, LockBusy, type LockPorts } from './lock'

let directory: string
const uid = process.getuid?.()
const ports: LockPorts = { pid: 123, isAlive: (pid) => pid === 123 }
const record = (pid = 456, token = 'a'.repeat(64)) =>
  JSON.stringify({ pid, token, startedAt: '2026-10-10T00:00:00.000Z' })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'host-lock-characterization-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

it('publishes a complete private lock before exposing it and cleans its temporary file', async () => {
  const release = await acquireIdentityLock(directory, uid, {
    ...ports,
    link: async (from, to) => {
      expect(JSON.parse(await readFile(from, 'utf8'))).toMatchObject({ pid: 123 })
      expect((await lstat(from)).mode & 0o777).toBe(0o600)
      await expect(lstat(to)).rejects.toMatchObject({ code: 'ENOENT' })
      await link(from, to)
    },
  })
  expect(await readdir(directory)).toEqual(['.lock'])
  await release()
  expect(await readdir(directory)).toEqual([])
})

it('refuses a live pid without changing the lock', async () => {
  const text = record(123)
  await writeFile(join(directory, '.lock'), text, { mode: 0o600 })
  await expect(acquireIdentityLock(directory, uid, ports)).rejects.toThrow(
    'Another phosphor login or logout is running (pid 123).',
  )
  expect(await readFile(join(directory, '.lock'), 'utf8')).toBe(text)
  expect(await readdir(directory)).toEqual(['.lock'])
})

it.each(['EPERM', 'ESRCH', 'EIO'])('keeps process.kill %s liveness semantics', async (code) => {
  await writeFile(join(directory, '.lock'), record(), { mode: 0o600 })
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('private'), { code })
  })
  if (code === 'ESRCH') {
    const release = await acquireIdentityLock(directory, uid)
    await release()
    expect(await readdir(directory)).toEqual([])
  } else {
    const attempt = acquireIdentityLock(directory, uid)
    await expect(attempt).rejects.toThrow(
      code === 'EPERM'
        ? 'Another phosphor login or logout is running (pid 456).'
        : 'Could not check the identity lock.',
    )
    expect(await readFile(join(directory, '.lock'), 'utf8')).toBe(record())
  }
})

it('does not treat a non-Error errno as a missing file', async () => {
  const failure = { code: 'ENOENT' }
  await expect(
    acquireIdentityLock(directory, uid, {
      ...ports,
      lstat: async () => {
        throw failure
      },
    }),
  ).rejects.toBe(failure)
  expect(await readdir(directory)).toEqual([])
})

it('refuses an unsafe identity directory before publishing', async () => {
  await chmod(directory, 0o755)
  await expect(acquireIdentityLock(directory, uid, ports)).rejects.toBeInstanceOf(IdentityFailure)
  expect(await readdir(directory)).toEqual([])
})

it('refuses a symlinked identity directory', async () => {
  const alias = join(directory, 'alias')
  await symlink(directory, alias)
  await expect(acquireIdentityLock(alias, uid, ports)).rejects.toBeInstanceOf(IdentityFailure)
  expect(await readdir(directory)).toEqual(['alias'])
})

it.each(['.lock', '.run-lock'] as const)(
  'keeps %s directory refusal diagnostics distinct',
  async (name) => {
    await mkdir(join(directory, name), { mode: 0o700 })
    await expect(acquireIdentityLock(directory, uid, ports, name)).rejects.toMatchObject({
      constructor: LockBusy,
      message: `Remove the directory identity/${name}, then retry phosphor ${name === '.lock' ? 'login or logout' : 'run'}.`,
    })
    expect(await readdir(directory)).toEqual([name])
  },
)

it.each(['.lock', '.run-lock'] as const)(
  'never reclaims %s recovery gates on age',
  async (name) => {
    await writeFile(join(directory, name), record(), { mode: 0o600 })
    const gate = join(directory, `${name}-recovery`)
    await mkdir(gate, { mode: 0o700 })
    const instant = new Date('2026-10-10T00:00:00.000Z')
    await utimes(gate, instant, instant)
    const waits: number[] = []
    await expect(
      acquireIdentityLock(
        directory,
        uid,
        {
          ...ports,
          now: () => instant.getTime() + 86_400_000,
          wait: async (ms) => void waits.push(ms),
        },
        name,
      ),
    ).rejects.toThrow(
      `A crashed phosphor ${name === '.lock' ? 'login or logout' : 'run'} left identity/${name}-recovery. If none is running, remove it and retry.`,
    )
    expect(waits).toEqual(Array.from({ length: 20 }, () => 50))
    expect((await lstat(gate)).isDirectory()).toBe(true)
    expect(await readFile(join(directory, name), 'utf8')).toBe(record())
    expect(await readdir(directory)).toEqual([name, `${name}-recovery`])
  },
)

it('a losing reclaimer preserves the winner even when it believes every pid is dead', async () => {
  await writeFile(join(directory, '.lock'), record(), { mode: 0o600 })
  await mkdir(join(directory, '.lock-recovery'), { mode: 0o700 })
  let winner: (() => Promise<void>) | undefined
  await expect(
    acquireIdentityLock(directory, uid, {
      ...ports,
      pid: 789,
      isAlive: () => false,
      wait: async () => {
        await rmdir(join(directory, '.lock-recovery'))
        winner = await acquireIdentityLock(directory, uid, ports)
      },
    }),
  ).rejects.toBeInstanceOf(LockBusy)
  expect(JSON.parse(await readFile(join(directory, '.lock'), 'utf8')).pid).toBe(123)
  await winner?.()
  expect(await readdir(directory)).toEqual([])
})

it.each(['inode', 'token'] as const)(
  'preserves a replacement with a different %s under the gate',
  async (kind) => {
    const path = join(directory, '.lock')
    await writeFile(path, record(), { mode: 0o600 })
    const before = await lstat(path)
    let reads = 0
    const replacement = record(456, kind === 'token' ? 'b'.repeat(64) : 'a'.repeat(64))
    await expect(
      acquireIdentityLock(directory, uid, {
        ...ports,
        lstat: async (name) => {
          if (++reads === 3) {
            if (kind === 'inode') {
              await writeFile(join(directory, 'other'), replacement, { mode: 0o600 })
              await rename(join(directory, 'other'), path)
            } else await writeFile(path, replacement)
          }
          return lstat(name)
        },
      }),
    ).rejects.toBeInstanceOf(LockBusy)
    expect(await readFile(path, 'utf8')).toBe(replacement)
    const after = await lstat(path)
    expect(after.ino === before.ino).toBe(kind === 'token')
    expect(await readdir(directory)).toEqual(['.lock'])
  },
)

it('rechecks liveness inside the gate before unlinking', async () => {
  await writeFile(join(directory, '.lock'), record(), { mode: 0o600 })
  let checks = 0
  await expect(
    acquireIdentityLock(directory, uid, { ...ports, isAlive: () => ++checks > 2 }),
  ).rejects.toThrow('running (pid 456)')
  expect(checks).toBe(4)
  expect(await readFile(join(directory, '.lock'), 'utf8')).toBe(record())
  expect(await readdir(directory)).toEqual(['.lock'])
})

it.each(['malformed', 'symlink'] as const)(
  'recovers a %s lock without following a target',
  async (kind) => {
    const target = join(directory, 'target')
    await writeFile(target, record(123), { mode: 0o600 })
    if (kind === 'symlink') await symlink(target, join(directory, '.lock'))
    else await writeFile(join(directory, '.lock'), '{', { mode: 0o600 })
    const release = await acquireIdentityLock(directory, uid, ports)
    expect(JSON.parse(await readFile(join(directory, '.lock'), 'utf8')).pid).toBe(123)
    await release()
    expect(await readFile(target, 'utf8')).toBe(record(123))
    expect(await readdir(directory)).toEqual(['target'])
  },
)

it('release removes only its own token and always removes its gate', async () => {
  const release = await acquireIdentityLock(directory, uid, ports)
  await unlink(join(directory, '.lock'))
  await writeFile(join(directory, '.lock'), record(), { mode: 0o600 })
  await release()
  expect(await readFile(join(directory, '.lock'), 'utf8')).toBe(record())
  expect(await readdir(directory)).toEqual(['.lock'])
})

it('keeps run-lock live-owner diagnostics separate from login and logout', async () => {
  await writeFile(join(directory, '.run-lock'), record(123), { mode: 0o600 })
  await expect(acquireIdentityLock(directory, uid, ports, '.run-lock')).rejects.toThrow(
    'Another phosphor run is running (pid 123).',
  )
  expect(await readdir(directory)).toEqual(['.run-lock'])
})
