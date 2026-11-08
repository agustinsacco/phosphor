import { randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import type { SessionRegistry } from '@phosphor/session-runtime/pi/session-registry'
import {
  purgeLearningRoot,
  readLearningControl,
  syncLearningDirectory,
} from './learning-carrier-files'

export interface LearningRootOwner {
  version: 1
  kind: 'brain-learning-root'
  jobId: string
  nonce: string
  creatorPid: number
  creatorInstanceId: string
  writerState: 'never-started' | 'possibly-running' | 'stopped'
}
interface RecoveryRuntime {
  directory: string
  paths: SessionPathRuntime
  registry: Pick<SessionRegistry, 'list' | 'get'>
}
const creatorInstanceId = randomBytes(32).toString('hex')
export function learningRootCreator(): Pick<LearningRootOwner, 'creatorPid' | 'creatorInstanceId'> {
  return { creatorPid: process.pid, creatorInstanceId }
}
async function persistOwner(
  root: string,
  owner: LearningRootOwner,
  initial: boolean,
): Promise<void> {
  const path = join(root, 'owner.json')
  const temporary = initial ? path : join(root, `.owner-${randomBytes(8).toString('hex')}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(owner))
    await file.sync()
  } finally {
    await file.close()
  }
  if (!initial) await rename(temporary, path)
  await syncLearningDirectory(root)
}
/** The directory lock must span allocation, snapshot writes and the pre-spawn state transition. */
export async function createLearningRoot(
  directory: string,
  jobId: string,
  nonce: string,
): Promise<string> {
  const root = await mkdtemp(join(await realpath(directory), 'learning-'))
  await persistOwner(
    root,
    {
      version: 1,
      kind: 'brain-learning-root',
      jobId,
      nonce,
      ...learningRootCreator(),
      writerState: 'never-started',
    },
    true,
  )
  await syncLearningDirectory(dirname(root))
  return root
}
async function readOwner(root: string): Promise<LearningRootOwner> {
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(root)) !== root)
    throw new Error('Unsafe private root')
  const owner = await readLearningControl<LearningRootOwner>(join(root, 'owner.json'))
  if (
    owner?.version !== 1 ||
    owner.kind !== 'brain-learning-root' ||
    typeof owner.jobId !== 'string' ||
    !/^[\w-]{1,128}$/.test(owner.jobId) ||
    typeof owner.nonce !== 'string' ||
    !/^[a-f0-9]{64}$/.test(owner.nonce) ||
    !Number.isSafeInteger(owner.creatorPid) ||
    owner.creatorPid < 1 ||
    owner.creatorPid > 0x7fffffff ||
    typeof owner.creatorInstanceId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(owner.creatorInstanceId) ||
    !['never-started', 'possibly-running', 'stopped'].includes(owner.writerState) ||
    Object.keys(owner).some(
      (key) =>
        ![
          'version',
          'kind',
          'jobId',
          'nonce',
          'creatorPid',
          'creatorInstanceId',
          'writerState',
        ].includes(key),
    )
  )
    throw new Error('Private root ownership or writer state is unverified')
  return owner
}
/** Caller owns the root lock; mark possible BEFORE spawn and stopped only AFTER writer disposal. */
export async function markLearningWriter(
  root: string,
  jobId: string,
  nonce: string,
  writerState: LearningRootOwner['writerState'],
): Promise<void> {
  const exists = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (!exists) {
    if (writerState !== 'stopped')
      throw new Error('Private root disappeared before writer admission')
    return
  }
  const owner = await readOwner(root)
  if (owner.jobId !== jobId || owner.nonce !== nonce)
    throw new Error('Private root ownership changed')
  if (writerState === 'possibly-running' && owner.writerState !== 'never-started')
    throw new Error('A private learning root cannot start another writer')
  await persistOwner(root, { ...owner, writerState }, false)
}
function retained(root: string, cause: unknown): Error {
  return new Error(
    `Private learning input retained at ${root}. Cannot prove safe ownership and a stopped writer. Close all Phosphor instances and use support-assisted recovery for this exact root; never kill a saved PID or delete other session folders.`,
    { cause },
  )
}
function canRecoverNeverStarted(owner: LearningRootOwner): boolean {
  // All real hosts share the existing directory lock with the complete preparation above.
  // Other instances need absence evidence: an alive/reused/unknown PID never permits deletion.
  if (owner.creatorPid === process.pid && owner.creatorInstanceId === creatorInstanceId) return true
  try {
    process.kill(owner.creatorPid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
async function recoverRoot(runtime: RecoveryRuntime, root: string): Promise<void> {
  await runtime.paths.withSessionPath(root, async () => {
    try {
      const owner = await readOwner(root)
      if (owner.writerState === 'never-started' && !canRecoverNeverStarted(owner))
        throw new Error('Snapshot creator may still be writing')
      if (owner.writerState === 'possibly-running')
        throw new Error('Previous writer stop is unproven')
      if (
        runtime.registry
          .list()
          .some(
            (item) =>
              item.workspacePath === join(root, 'cwd') || item.diskPath?.startsWith(root + '/'),
          )
      )
        throw new Error('A registered process still owns this private root')
      await purgeLearningRoot(root, owner.jobId, owner.nonce)
    } catch (error) {
      throw retained(root, error)
    }
  })
}
/** Disk inventory is the durable pending set, including preview-only attempts with no job row.
 * Uses the existing process-local lock domain; it is not a cross-process writer lease.
 */
export async function withLearningRootRecovery<T>(
  runtime: RecoveryRuntime,
  run: () => Promise<T>,
): Promise<T> {
  await mkdir(runtime.directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(runtime.directory)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw retained(runtime.directory, new Error('Unsafe inventory directory'))
  return runtime.paths.withSessionPath(runtime.directory, async () => {
    const directory = await realpath(runtime.directory)
    const entries = (await readdir(directory)).filter((name) => name.startsWith('learning-')).sort()
    if (entries.length > 1000)
      throw retained(directory, new Error('Private root inventory exceeds limit'))
    for (const name of entries) await recoverRoot(runtime, join(directory, name))
    return run()
  })
}
