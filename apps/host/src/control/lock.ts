import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { publishLinkLock } from '@phosphor/session-runtime/owner-lock/link-lock'
import { checkIdentityDirectory, IdentityFailure } from './identity'
import {
  identityLinkLock,
  releaseIdentityLock,
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
  await publishLinkLock(
    identityLinkLock(state),
    temp,
    JSON.stringify({ pid: ports.pid, token, startedAt: new Date().toISOString() }) + '\n',
  )
  return () => releaseIdentityLock(state)
}
