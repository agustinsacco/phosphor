import { createPrivateKey, randomUUID } from 'node:crypto'
import { lstat, rename } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { HOST_API_PORT } from '@phosphor/shared/host-protocol'
import {
  HOST_SIDECARS as files,
  parseLocalIdentityFile,
  parseOwnerClientsFile,
  type OwnerClientsFile,
} from '@phosphor/shared/host-local'
import { errorText } from '@phosphor/shared/errors'
import { errnoIs, isOwnerPrivate } from '@phosphor/session-runtime/fs-safety'
import { EXIT } from '../checks'
import { loadHostConfig } from '../config/load'
import { readLocalMode, readSidecar, writeSidecar, type SidecarName } from '../config/sidecar'
import { withCommandLock } from '../control/command'
import { identityDirectory } from '../control/identity'
import {
  identityEntryExists,
  readIdentityFile,
  writeIdentityFileAtomic,
} from '../control/identity-files'
import { exportKeyPem } from '../control/identity-records'
import { LockBusy } from '../control/lock'
import { freshKey, publicIdentity } from '../control/signer'
import { hostStateDirectory, prepareStateDirectory } from '../lanes/state-dir'
import { SERVICE_LOG_NAMES } from './setup-local-service'
import { runService, type ServiceContext } from './service'
import { runSetup, type SetupContext, type SetupReport } from './setup'

type Owner = Pick<OwnerClientsFile['clients'][number], 'id' | 'label' | 'publicKey'>
export interface LocalSetupContext extends SetupContext, ServiceContext {
  owner: Owner
  standby?: boolean
  portAvailable?: (port: number) => Promise<boolean>
}
interface LocalReport extends SetupReport {
  machineId?: string
  publicKey?: string
}

function available(port: number): Promise<boolean> {
  return new Promise((done, reject) => {
    const server = createServer()
    server.once('error', (error) => (errnoIs(error, 'EADDRINUSE') ? done(false) : reject(error)))
    server.listen(port, '127.0.0.1', () =>
      server.close((error) => (error ? reject(error) : done(true))),
    )
  })
}

async function prepareConfig(context: LocalSetupContext): Promise<LocalReport> {
  const config = context.configPath
  const report = { config, checks: [], notes: [] }
  if (await identityEntryExists(config)) {
    const loaded = await loadHostConfig(config, context.uid)
    if (!loaded.ok)
      return { ...report, exitCode: EXIT.config, notes: ['The existing config is not usable.'] }
    return { ...report, exitCode: EXIT.ok, changed: false }
  }
  for (let port = HOST_API_PORT; port <= HOST_API_PORT + 16; port++)
    if (await (context.portAvailable ?? available)(port))
      return runSetup({
        ...context,
        localPort: port,
        replace: false,
        repositories: [],
        tailscaleHints: false,
      })
  return { ...report, exitCode: EXIT.unavailable, notes: ['No loopback API port is available.'] }
}

function existing<T>(
  directory: string,
  name: SidecarName,
  parse: (raw: Record<string, unknown>) => T | null,
  uid: number | undefined,
) {
  const result = readSidecar(directory, name, parse, { uid })
  if (result.state === 'invalid') throw new Error(`${name} is not usable. No file was replaced.`)
  return result.state === 'ok' ? result.value : null
}

async function identity(directory: string, uid: number | undefined, now: string) {
  const previous = existing(directory, files.localIdentity, parseLocalIdentityFile, uid)
  const pemExists = await identityEntryExists(join(directory, files.localKey))
  if (previous && !pemExists) throw new Error('The local service key is missing.')
  const key = pemExists
    ? createPrivateKey(await readIdentityFile(directory, uid, files.localKey))
    : freshKey()
  const { publicKey } = publicIdentity(key)
  if (previous && previous.publicKey !== publicKey)
    throw new Error('The local service key does not match its identity.')
  if (previous) return previous
  if (!pemExists)
    await writeIdentityFileAtomic(
      { directory, uid, ports: { rename } },
      files.localKey,
      exportKeyPem(key),
    )
  const value = { version: 1 as const, machineId: randomUUID(), createdAt: now, publicKey }
  writeSidecar(directory, files.localIdentity, value, { uid, known: [] })
  return value
}

function pair(directory: string, uid: number | undefined, owner: Owner, now: string) {
  // Keep unknown keys on nested client entries, too; the shared parser strips them.
  const previous =
    existing(
      directory,
      files.ownerClients,
      (raw) =>
        parseOwnerClientsFile(raw) &&
        (raw.clients as (OwnerClientsFile['clients'][number] & Record<string, unknown>)[]),
      uid,
    ) ?? []
  const before = previous.find((client) => client.id === owner.id)
  if (before?.publicKey === owner.publicKey && before.label === owner.label) return
  const next = { ...before, ...owner, addedAt: before?.addedAt ?? now }
  const value = {
    version: 1,
    clients: before
      ? previous.map((client) => (client.id === owner.id ? next : client))
      : [...previous, next],
  }
  if (!parseOwnerClientsFile(value))
    throw new Error('Owner pairing is invalid or the client limit was reached.')
  writeSidecar(directory, files.ownerClients, value, { uid, known: [] })
}

async function checkLogs(state: string, uid: number | undefined) {
  const logs = join(state, 'logs')
  if (!(await identityEntryExists(logs))) return
  prepareStateDirectory(logs, uid)
  if (((await lstat(logs)).mode & 0o7777) !== 0o700)
    throw new Error('The existing logs directory must be 0700. No permissions were changed.')
  for (const name of SERVICE_LOG_NAMES) {
    const path = join(logs, name)
    if (!(await identityEntryExists(path))) continue
    const info = await lstat(path)
    if (!info.isFile() || !isOwnerPrivate(info, uid) || info.nlink !== 1)
      throw new Error(`Unsafe service log: ${name}.`)
  }
}

/** Pair and publish the marker last under the identity command lock. Service install is outside the lock. */
export async function runLocalSetup(input: LocalSetupContext): Promise<LocalReport> {
  const context = { ...input, configPath: resolve(input.cwd, input.configPath) }
  const directory = dirname(context.configPath)
  const state = hostStateDirectory(context.env, context.home)
  const now = new Date(context.now?.() ?? Date.now()).toISOString()
  const report: LocalReport = {
    config: context.configPath,
    checks: [],
    notes: [],
    exitCode: EXIT.config,
  }
  try {
    if (!['darwin', 'linux'].includes(context.platform))
      return {
        ...report,
        exitCode: EXIT.unavailable,
        notes: ['The Phosphor service needs macOS or Linux.'],
      }
    if (!parseOwnerClientsFile({ version: 1, clients: [{ ...context.owner, addedAt: now }] }))
      return { ...report, exitCode: EXIT.usage, notes: ['Invalid owner id, public key or label.'] }
    prepareStateDirectory(state, context.uid)
    await checkLogs(state, context.uid)
    prepareStateDirectory(directory, context.uid)
    await withCommandLock(context, async () => {
      const mode = readLocalMode(directory, context.uid)
      const standby = existing(
        state,
        files.standby,
        (raw) => (raw.version === 1 ? raw : null),
        context.uid,
      )
      if (
        context.standby &&
        !standby &&
        (await identityEntryExists(join(identityDirectory(context.configPath), '.run-lock')))
      )
        throw new Error('Release the running service before requesting standby.')
      Object.assign(report, await prepareConfig(context))
      if (report.exitCode !== 0) return
      const local = await identity(directory, context.uid, now)
      pair(directory, context.uid, context.owner, now)
      if (context.standby && !standby)
        writeSidecar(state, files.standby, { version: 1 }, { uid: context.uid, known: [] })
      if (!mode)
        writeSidecar(
          directory,
          files.localMode,
          { version: 1, enabledAt: now, shellEnvironment: true },
          { uid: context.uid, known: [] },
        )
      report.machineId = local.machineId
      report.publicKey = local.publicKey
      delete report.next
    })
    if (report.exitCode === 0)
      report.exitCode = await runService(
        { ...context, print: (line) => report.notes.push(line) },
        'install',
      )
  } catch (error) {
    report.exitCode = error instanceof LockBusy ? EXIT.tempfail : EXIT.config
    report.notes.push(errorText(error))
  }
  return report
}
