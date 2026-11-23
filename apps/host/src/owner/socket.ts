import { createHash, createPrivateKey, type KeyObject } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  HOST_SIDECARS,
  localSocketCandidates,
  parseLocalIdentityFile,
  parseLocalRunFile,
  parseOwnerClientsFile,
  type LocalIdentityFile,
  type LocalRunFile,
} from '@phosphor/shared/host-local'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { readOwnerLock } from '@phosphor/session-runtime/owner-lock/owner-lock'
import { piAgentDir } from '@phosphor/session-runtime/pi/pi-paths'
import { startLocalServer } from '../api/local-server'
import { hostLinks } from '../api/server'
import { readSidecar, writeSidecar } from '../config/sidecar'
import { readIdentityFile } from '../control/identity-files'
import { IdentityFailure } from '../control/identity-records'
import { EnrollmentRefused } from '../control/link'
import { publicIdentity } from '../control/signer'
import { runServiceFeatures } from '../commands/run-services'
import type { RunContext } from '../commands/run'
import type { LocalDaemon, LocalSocket, StartLocalSocket } from '../commands/run-local'
import { hostStateDirectory } from '../lanes/state-dir'
import type { OpsAdapterPorts } from '../ops/adapter'
import { HOST_VERSION } from '../version'
import { createOwnerAdapter, OwnerCallRefused, type OwnerHandlers } from './adapter'
import { localStatus } from './status'

/**
 * The socket paths `run` tries, in order: `$XDG_RUNTIME_DIR` on Linux, then
 * `<state>/run`, then `/tmp/phosphor-<uid>/<hash>.sock` when the others are too long.
 */
export function localSocketPaths(
  context: Pick<RunContext, 'env' | 'home' | 'uid'>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const stateDir = hostStateDirectory(context.env, context.home)
  return localSocketCandidates({
    platform: platform === 'linux' ? 'linux' : 'darwin',
    stateDir,
    runtimeDir: context.env.XDG_RUNTIME_DIR,
    uid: context.uid ?? -1,
    stateHash16: createHash('sha256').update(stateDir).digest('hex').slice(0, 16),
  })
}

const unusable = () =>
  new IdentityFailure('The local service identity is not usable. Run phosphor setup --local again.')

/** `local-identity.json` and the key it names, which must match. */
async function readLocalIdentity(
  directory: string,
  uid: number | undefined,
): Promise<{ identity: LocalIdentityFile; key: KeyObject }> {
  const read = readSidecar(directory, HOST_SIDECARS.localIdentity, parseLocalIdentityFile, { uid })
  if (read.state !== 'ok') throw unusable()
  let key: KeyObject
  try {
    key = createPrivateKey(await readIdentityFile(directory, uid, HOST_SIDECARS.localKey))
  } catch {
    throw unusable()
  }
  if (key.asymmetricKeyType !== 'ed25519' || publicIdentity(key).publicKey !== read.value.publicKey)
    throw unusable()
  return { identity: read.value, key }
}

/** The calls D3 serves: the machine's status, identity re-read and in-process enrollment. */
function daemonHandlers(
  context: RunContext,
  daemon: LocalDaemon,
  machineId: string,
): OwnerHandlers {
  const agentDir = piAgentDir(context.env, context.home)
  const statusPorts = {
    machineId,
    hostVersion: HOST_VERSION,
    daemon,
    features: runServiceFeatures,
    ownerLock: () => readOwnerLock(agentDir, context.uid),
  }
  return {
    'machine.local': (_params, call) => localStatus(statusPorts, call.principal),
    'machine.identity.reload': async () => {
      await daemon.link()?.reload()
      return { mode: daemon.link()?.mode() ?? 'local' }
    },
    'machine.enroll': async (params) => {
      try {
        if (params.action === 'cancel') {
          await daemon.cancelEnrollment()
          return { cancelled: true }
        }
        return await daemon.beginEnrollment()
      } catch (error) {
        if (error instanceof EnrollmentRefused)
          throw new OwnerCallRefused('forbidden', error.message)
        throw error
      }
    },
  }
}

const LOCAL_RUN_KEYS = [
  'version',
  'pid',
  'hostVersion',
  'machineId',
  'socket',
  'startedAt',
  'localReadyAt',
] as const satisfies readonly (keyof LocalRunFile)[]

/** Removes `local.json` only while it still names this process. */
function removeLocalRun(state: string, uid: number | undefined) {
  const read = readSidecar(state, HOST_SIDECARS.localRun, parseLocalRunFile, { uid })
  if (read.state !== 'ok' || read.value.pid !== process.pid) return
  try {
    unlinkSync(join(state, HOST_SIDECARS.localRun))
  } catch (error) {
    if (!errnoIs(error, 'ENOENT')) throw error
  }
}

export interface LocalSocketOptions {
  /** Tests pass temporary paths; the service uses `localSocketPaths`. */
  candidates?: readonly string[]
  /** More owner methods, served beside D3's (`machine.local`, `machine.identity.reload`, `machine.enroll`). */
  handlers?: OwnerHandlers
  /** `ops.run` on the socket, once the lanes start (B1 binds the dispatcher). */
  ops?: OpsAdapterPorts
}

/**
 * Starts the owner socket for `run`'s local mode: reads the local identity
 * (exit 78 when it is not usable), binds the socket, writes `<state>/local.json`
 * once it accepts connections, and serves only owner calls until the lanes start.
 */
export function createLocalSocketStarter(
  context: RunContext,
  options: LocalSocketOptions = {},
): StartLocalSocket {
  return async (daemon): Promise<LocalSocket> => {
    const uid = context.uid
    const { identity, key } = await readLocalIdentity(dirname(resolve(context.configPath)), uid)
    const handlers = { ...daemonHandlers(context, daemon, identity.machineId), ...options.handlers }
    const configDirectory = dirname(resolve(context.configPath))
    const now = context.now ?? Date.now
    const startedAt = now()
    const server = await startLocalServer({
      candidates: options.candidates ?? localSocketPaths(context),
      uid,
      hostVersion: HOST_VERSION,
      auth: {
        machineId: identity.machineId,
        key,
        ownerClients: () => {
          const read = readSidecar(
            configDirectory,
            HOST_SIDECARS.ownerClients,
            parseOwnerClientsFile,
            { uid },
          )
          return read.state === 'ok' ? read.value : null
        },
      },
      links: [createOwnerAdapter(handlers)],
      log: (event, fields) => context.log?.('host', event, fields),
      now,
    })
    const state = hostStateDirectory(context.env, context.home)
    const run: LocalRunFile = {
      version: 1,
      pid: process.pid,
      hostVersion: HOST_VERSION,
      machineId: identity.machineId,
      socket: server.path,
      startedAt,
      localReadyAt: now(),
    }
    try {
      writeSidecar(state, HOST_SIDECARS.localRun, { ...run }, { uid, known: LOCAL_RUN_KEYS })
    } catch (error) {
      await server.stop()
      throw error
    }
    return {
      connections: server.connections,
      serveLanes: (lanes) =>
        server.serveLanes({
          epoch: lanes.service.epoch,
          capabilities: lanes.service.capabilities,
          links: hostLinks(options.ops, handlers),
          handler: lanes.adapter.handler,
          peers: lanes.peers,
        }),
      async stop() {
        try {
          removeLocalRun(state, uid)
        } finally {
          await server.stop()
        }
      },
    }
  }
}
