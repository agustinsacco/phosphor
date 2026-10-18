import { mkdir, open, link, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { errnoIs } from '../fs-safety'
import { checkIdentityDirectory, IdentityFailure } from './identity'
import {
  lockBusy,
  reclaimLock,
  releaseIdentityLock,
  snapshotLock,
  type LockPorts,
  type LockState,
} from './lock-recovery'

export { LockBusy, type LockPorts } from './lock-recovery'

const defaultPorts: LockPorts = {
  pid: process.pid,
  isAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (error instanceof Error && errnoIs(error, 'EPERM')) return true
      if (error instanceof Error && errnoIs(error, 'ESRCH')) return false
      throw new IdentityFailure('Could not check the identity lock.')
    }
  },
}

export async function acquireIdentityLock(
  directory: string,
  uid: number | undefined,
  ports: LockPorts = defaultPorts,
  name: '.lock' | '.run-lock' = '.lock',
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await checkIdentityDirectory(directory, uid)
  const path = join(directory, name)
  const gatePath = join(directory, `${name}-recovery`)
  const token = randomBytes(32).toString('hex')
  const temp = join(directory, `${name}.${token}.tmp`)
  const state: LockState = { path, gatePath, token, name, directory, uid, ports }
  const existing = await snapshotLock(state)
  if (existing?.lock && ports.isAlive(existing.lock.pid)) throw lockBusy(state, existing.lock.pid)
  const file = await open(temp, 'wx', 0o600)
  try {
    try {
      await file.writeFile(
        JSON.stringify({ pid: ports.pid, token, startedAt: new Date().toISOString() }) + '\n',
      )
      await file.sync()
    } finally {
      await file.close()
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await (ports.link ?? link)(temp, path)
        break
      } catch (error) {
        if (!(error instanceof Error && errnoIs(error, 'EEXIST'))) throw error
        const stale = await snapshotLock(state)
        if (stale?.lock && ports.isAlive(stale.lock.pid)) throw lockBusy(state, stale.lock.pid)
        if (attempt === 1) throw lockBusy(state)
        await reclaimLock(state, stale)
      }
    }
  } finally {
    await unlink(temp)
  }
  return () => releaseIdentityLock(state)
}
