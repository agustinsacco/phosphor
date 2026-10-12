import {
  link,
  lstat,
  rename,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  unlink,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireIdentityLock, LockBusy, type LockPorts } from './lock'

let dir: string
const uid = process.getuid?.()
const ports: LockPorts = { pid: 123, isAlive: (pid) => pid === 123 }
const record = (pid: number) =>
  JSON.stringify({ pid, token: 'a'.repeat(64), startedAt: '2026-10-10T00:00:00.000Z' })
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-lock-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})
describe('identity lock', () => {
  it('publishes complete content atomically, refusing a live lock without changing any file', async () => {
    const release = await acquireIdentityLock(dir, uid, {
      ...ports,
      link: async (from, to) => {
        expect(JSON.parse(await readFile(from, 'utf8'))).toMatchObject({ pid: 123 })
        await expect(readFile(to)).rejects.toMatchObject({ code: 'ENOENT' })
        await link(from, to)
        const before = await readFile(to, 'utf8')
        await expect(acquireIdentityLock(dir, uid, ports)).rejects.toThrow('running (pid 123)')
        expect(await readFile(to, 'utf8')).toBe(before)
      },
    })
    expect(await readdir(dir)).toEqual(['.lock'])
    await release()
    expect(await readdir(dir)).toEqual([])
  })
  it.each(['dead', 'invalid', 'unreadable'])('recovers a %s lock', async (kind) => {
    await writeFile(join(dir, '.lock'), kind === 'invalid' ? '{}' : record(456), {
      mode: kind === 'unreadable' ? 0o644 : 0o600,
    })
    const release = await acquireIdentityLock(dir, uid, ports)
    expect(JSON.parse(await readFile(join(dir, '.lock'), 'utf8')).pid).toBe(123)
    await release()
  })
  it('release never deletes another process token', async () => {
    const release = await acquireIdentityLock(dir, uid, ports)
    await unlink(join(dir, '.lock'))
    await writeFile(join(dir, '.lock'), record(456), { mode: 0o600 })
    await release()
    expect(await readFile(join(dir, '.lock'), 'utf8')).toBe(record(456))
  })
  it('two reclaimers cannot remove the fresh lock created by the winner', async () => {
    await writeFile(join(dir, '.lock'), record(456), { mode: 0o600 })
    let winner: (() => Promise<void>) | undefined
    let checks = 0
    const loser = {
      ...ports,
      pid: 789,
      isAlive: () => {
        checks++
        return false
      },
      wait: async () => {
        await rmdir(join(dir, '.lock-recovery'))
        winner = await acquireIdentityLock(dir, uid, ports)
      },
    }
    await mkdir(join(dir, '.lock-recovery'), { mode: 0o700 })
    await expect(acquireIdentityLock(dir, uid, loser)).rejects.toBeInstanceOf(LockBusy)
    expect(checks).toBeGreaterThan(1)
    expect(JSON.parse(await readFile(join(dir, '.lock'), 'utf8')).pid).toBe(123)
    await winner?.()
  })
  it.each([30_000, 30_001, 86_400_000])(
    'never removes a gate it did not create (age %s ms), and names a crash-left one',
    async (age) => {
      await writeFile(join(dir, '.lock'), record(456), { mode: 0o600 })
      const gate = join(dir, '.lock-recovery')
      await mkdir(gate, { mode: 0o700 })
      const instant = new Date('2026-10-10T00:00:00.000Z')
      await utimes(gate, instant, instant)
      const waits: number[] = []
      const attempt = acquireIdentityLock(dir, uid, {
        ...ports,
        now: () => instant.getTime() + age,
        wait: async (ms) => {
          waits.push(ms)
        },
      })
      await expect(attempt).rejects.toBeInstanceOf(LockBusy)
      await expect(attempt).rejects.toThrow(
        age > 30_000 ? 'left identity/.lock-recovery' : 'Another phosphor login or logout',
      )
      expect(waits).toEqual(Array.from({ length: 20 }, () => 50))
      expect((await lstat(gate)).isDirectory()).toBe(true)
      expect(await readFile(join(dir, '.lock'), 'utf8')).toBe(record(456))
      await rmdir(gate)
      const release = await acquireIdentityLock(dir, uid, ports)
      await release()
      expect(await readdir(dir)).toEqual([])
    },
  )
  it.each(['EPERM', 'ESRCH'])(
    'interprets process.kill %s without weakening liveness',
    async (code) => {
      await writeFile(join(dir, '.lock'), record(456), { mode: 0o600 })
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('private error'), { code })
      })
      if (code === 'EPERM')
        await expect(acquireIdentityLock(dir, uid)).rejects.toThrow('running (pid 456)')
      else {
        const release = await acquireIdentityLock(dir, uid)
        await release()
      }
    },
  )
  it('never reclaims an invalid lock replaced by another invalid lock before the gate', async () => {
    const path = join(dir, '.lock')
    await writeFile(path, '{}', { mode: 0o600 })
    let reads = 0
    const replaced = {
      ...ports,
      lstat: async (name: string) => {
        // Third read is the recheck under the gate: another invalid file now sits there.
        if (++reads === 3) {
          await writeFile(join(dir, 'other'), '{"other":1}', { mode: 0o600 })
          await rename(join(dir, 'other'), path)
        }
        return lstat(name)
      },
    }
    await expect(acquireIdentityLock(dir, uid, replaced)).rejects.toBeInstanceOf(LockBusy)
    expect(await readFile(path, 'utf8')).toBe('{"other":1}')
  })
  it('rechecks liveness under the gate and keeps a lock whose owner now looks alive', async () => {
    const path = join(dir, '.lock')
    await writeFile(path, record(456), { mode: 0o600 })
    let checks = 0
    const flipping = { ...ports, isAlive: (pid: number) => pid === 123 || ++checks > 2 }
    await expect(acquireIdentityLock(dir, uid, flipping)).rejects.toThrow('running (pid 456)')
    expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(456)
  })
  it('reclaims a symlinked lock without touching its target', async () => {
    const target = join(dir, 'target')
    await writeFile(target, record(456), { mode: 0o600 })
    await symlink(target, join(dir, '.lock'))
    const release = await acquireIdentityLock(dir, uid, ports)
    expect(await readFile(target, 'utf8')).toBe(record(456))
    await release()
    expect(await readFile(target, 'utf8')).toBe(record(456))
  })
  it('refuses a directory lock with exit-75 error and a removal instruction', async () => {
    await mkdir(join(dir, '.lock'), { mode: 0o700 })
    await expect(acquireIdentityLock(dir, uid, ports)).rejects.toMatchObject({
      constructor: LockBusy,
      message: expect.stringContaining('Remove the directory identity/.lock'),
    })
    expect(await readdir(dir)).toEqual(['.lock'])
  })
  it('uses the readable lock fstat identity when the path changes between lstat and safe read', async () => {
    const path = join(dir, '.lock')
    const replacement = join(dir, 'replacement')
    await writeFile(path, record(456), { mode: 0o600 })
    await writeFile(replacement, record(456), { mode: 0o600 })
    let reads = 0
    const release = await acquireIdentityLock(dir, uid, {
      ...ports,
      lstat: async (name) => {
        const info = await lstat(name)
        if (++reads === 2) await rename(replacement, path)
        return info
      },
    })
    expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(123)
    await release()
  })
  it.each([0, -1, 2147483648, 1.5])(
    'treats invalid pid %s as recoverable without probing it',
    async (pid) => {
      await writeFile(join(dir, '.lock'), record(pid), { mode: 0o600 })
      const isAlive = vi.fn(ports.isAlive)
      const release = await acquireIdentityLock(dir, uid, { ...ports, isAlive })
      expect(isAlive).not.toHaveBeenCalled()
      await release()
    },
  )
  it('accepts the maximum pid as live, without using the lock age as a timeout', async () => {
    await writeFile(join(dir, '.lock'), record(2147483647), { mode: 0o600 })
    await expect(acquireIdentityLock(dir, uid, { ...ports, isAlive: () => true })).rejects.toThrow(
      'running (pid 2147483647)',
    )
  })
})
