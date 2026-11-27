import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createBrainService } from '@phosphor/brain-runtime/service'
import type { BrainEmbeddings } from '@phosphor/brain-runtime/embedding/embedding-port'
import type {
  BrainAgentHost,
  BrainApi,
  BrainLanes,
  BrainSearchPort,
  BrainService,
  BrainServiceOptions,
} from '@phosphor/brain-runtime/types'
import { openBrainStore } from '@phosphor/memory-engine/store'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import { guardBrainService, type BrainOwnership } from './runtime-guard'
import { hostBrainWriter, HostBrainWriterBusy } from './writer-lock'

/** `<state>/brain`: the Host's persistent per-user state, never its install or its enrolled id. */
export const hostBrainDirectory = (stateDirectory: string): string => join(stateDirectory, 'brain')
/** The reserved Brain lane's folder. Brain never reads lanes there. */
export const hostBrainLaneFolder = (stateDirectory: string): string =>
  join(hostBrainDirectory(stateDirectory), 'Brain')
const STORE = 'brain.sqlite'

/**
 * Supplied by the Desktop-to-Host move. `owned()` is false while that move imports into, or has
 * not verified, this Host's Brain: the Host then neither opens nor writes it.
 */
export interface HostBrainMigrationGuard {
  owned(): boolean
}

/**
 * - `off`: this Host has no Brain store (a fresh Host). Nothing is created until `enable()`.
 * - `refused`: the migration guard, or another open Brain on the same folder (in this process
 *   or another, `<state>/brain-writer.lock`), owns it now.
 * - `idle`: a store exists and opens on first use; no worker runs yet.
 * - `unavailable`: opening failed; the next call tries again.
 * Brain on or off is the store's own preference, read from `api.status()` once open.
 */
export type HostBrainState =
  'off' | 'refused' | 'idle' | 'starting' | 'ready' | 'unavailable' | 'closed'

export interface HostBrainOptions {
  /** The Host state folder (`hostStateDirectory`). */
  stateDirectory: string
  /** The folder holding brain-ext/ and skills/. */
  resourceRoot: string
  lanes: BrainLanes
  /** The Brain Agent lane, from its owner. Absent: no curator and no Defrag turns. */
  agent?: (laneFolder: string) => BrainAgentHost
  migrationGuard?: HostBrainMigrationGuard
  /** Verify and pin the selected install before opening or creating persistent state. */
  beforeOpen?(): void
  /** Local embeddings over `<brain>/embeddings`; built only when the Brain opens. */
  embeddings: (directory: string) => BrainEmbeddings
  /** Read-only search over `<brain>/brain.sqlite`. */
  openSearch: (path: string) => BrainSearchPort
  /** Tests only: never launch a provider. */
  runModelCall?: BrainServiceOptions['runModelCall']
  onChange?: () => void
  log: (message: string, data?: Record<string, unknown>) => void
  now?: () => number
}

export interface HostBrain {
  readonly directory: string
  readonly laneFolder: string
  state(): HostBrainState
  /** This Host's own Brain answers its lanes: a store exists and the Host owns it. */
  active(): boolean
  /** The open service, opening an existing store. Undefined when `off` or `refused`; never creates. */
  service(): Promise<GuardedBrainService | undefined>
  /** Opens the store, creating it if needed, without changing Brain on or off. */
  open(): Promise<GuardedBrainService>
  /** Creates the store if needed and turns Brain on. Refuses while the guard does. */
  enable(): Promise<GuardedBrainService>
  /** Stops admitting calls, settles or interrupts work, releases workers, then ownership. */
  dispose(): Promise<void>
}

/** What Host handlers use: every entry point rechecks ownership and shutdown. */
export type GuardedBrainService = Pick<
  BrainService,
  'agent' | 'forLane' | 'recallLaunch' | 'curatorLaunch' | 'guarded' | 'job' | 'evidence'
> & { api: BrainApi }

/**
 * One Brain per folder in this process, answered synchronously. Across processes the writer lock
 * (`writer-lock.ts`) is taken before the store opens.
 */
const opened = new Set<string>()

/** Opens `<brain>/brain.sqlite` and composes the runtime around it, creating the folder. */
async function constructHostBrainService(
  options: HostBrainOptions,
  directory: string,
  laneFolder: string,
): Promise<BrainService> {
  options.beforeOpen?.()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const embeddings = options.embeddings(join(directory, 'embeddings'))
  try {
    return await createBrainService({
      directory,
      openStore: (path) => openBrainStore({ path, Database: loadSqlite().DatabaseSync }),
      openSearch: options.openSearch,
      embeddings,
      lanes: options.lanes,
      ...(options.runModelCall ? { runModelCall: options.runModelCall } : {}),
      onChange: () => options.onChange?.(),
      guardExtension: join(options.resourceRoot, 'brain-ext/brain-fork-guard.mjs'),
      recall: {
        extension: join(options.resourceRoot, 'brain-ext/brain.mjs'),
        skill: join(options.resourceRoot, 'skills/brain'),
      },
      ...(options.agent
        ? {
            curator: {
              extension: join(options.resourceRoot, 'brain-ext/brain-curator.mjs'),
              skill: join(options.resourceRoot, 'skills/brain-agent'),
            },
            agent: options.agent(laneFolder),
          }
        : {}),
      log: options.log,
      ...(options.now ? { now: options.now } : {}),
    })
  } catch (error) {
    embeddings.dispose()
    throw error
  }
}

/** This instance's hold on its folder: one Brain per folder in the process. */
function folderClaim(directory: string) {
  let holder = false
  return {
    held: () => holder,
    /** Takes the folder unless another instance holds it; a closing one never takes it back. */
    take(closing: boolean): boolean {
      if (!holder && !closing && !opened.has(directory)) {
        opened.add(directory)
        holder = true
      }
      return holder
    },
    release() {
      if (holder) opened.delete(directory)
      holder = false
    },
  }
}

/** The service, opened once; a failed open is retried by the next call, not cached forever. */
function serviceOpener(construct: () => Promise<BrainService>, log: HostBrainOptions['log']) {
  let pending: Promise<BrainService> | undefined
  let open: BrainService | undefined
  let failed = false
  return {
    pending: () => pending,
    open: () => open,
    failed: () => failed,
    start(): Promise<BrainService> {
      pending ??= construct().then(
        (service) => {
          open = service
          failed = false
          return service
        },
        (error: unknown) => {
          pending = undefined
          failed = true
          log('Brain unavailable', {
            error: error instanceof Error ? error.message : 'Unknown error',
          })
          throw error
        },
      )
      return pending
    },
    forget() {
      open = undefined
    },
  }
}

/**
 * Opens the service behind the cross-process writer lock, taken before the store opens, recovers
 * or migrates. Ownership is read again once the lock is held, since a move may have claimed the
 * target meanwhile. Without `create`, a store that is gone by then is not made: the lock goes back
 * and nothing opens. One wrapper per open service, so a lane's port stays bound to it.
 */
function guardedStarter(ports: {
  opener: ReturnType<typeof serviceOpener>
  writer: ReturnType<typeof hostBrainWriter>
  ownership: BrainOwnership
  store: string
}) {
  const { opener, writer, ownership, store } = ports
  async function takeWriter(create: boolean): Promise<boolean> {
    await writer.take()
    try {
      ownership.check()
    } catch (error) {
      await writer.release()
      throw error
    }
    if (create || opener.pending() || existsSync(store)) return true
    await writer.release()
    return false
  }
  let wrapped: { service: BrainService; guarded: GuardedBrainService } | undefined
  return async function started(create: boolean): Promise<GuardedBrainService | undefined> {
    ownership.check()
    if (!writer.held() && !(await takeWriter(create))) return undefined
    // A concurrent caller that found no store may have given the lock back meanwhile.
    if (!writer.held()) throw new HostBrainWriterBusy('contended')
    // A failed open gives the writer lock back, so another Host process may try.
    const service = await opener.start().catch(async (error: unknown) => {
      await writer.release()
      throw error
    })
    if (wrapped?.service !== service)
      wrapped = { service, guarded: guardBrainService(service, ownership) }
    return wrapped.guarded
  }
}

export function createHostBrain(options: HostBrainOptions): HostBrain {
  const directory = hostBrainDirectory(options.stateDirectory)
  const laneFolder = hostBrainLaneFolder(options.stateDirectory)
  const store = join(directory, STORE)
  const folder = folderClaim(directory)
  const writer = hostBrainWriter(options.stateDirectory)
  const opener = serviceOpener(
    () => constructHostBrainService(options, directory, laneFolder),
    options.log,
  )
  let closing: Promise<void> | undefined
  const owned = () => !options.migrationGuard || options.migrationGuard.owned()
  const claim = () => folder.take(closing !== undefined)
  const exists = () => opener.pending() !== undefined || existsSync(store)
  const writerRefused = () => !writer.held() && writer.busy()
  const ownership: BrainOwnership = {
    check() {
      if (closing) throw new Error('Brain is shutting down.')
      if (!owned()) throw new Error('Brain is moving to this Host.')
      if (!folder.held()) throw new Error('Brain is open elsewhere on this Host.')
    },
  }
  const started = guardedStarter({ opener, writer, ownership, store })
  async function openOrCreate(): Promise<GuardedBrainService> {
    if (closing) throw new Error('Brain is shutting down.')
    if (!owned()) throw new Error('Brain is moving to this Host.')
    if (!claim()) throw new Error('Brain is open elsewhere on this Host.')
    const service = await started(true)
    if (!service) throw new Error('Brain is unavailable.')
    return service
  }

  return {
    directory,
    laneFolder,
    state() {
      if (closing) return 'closed'
      if (!owned()) return 'refused'
      if (!exists()) return 'off'
      if (!claim() || writerRefused()) return 'refused'
      if (opener.open()) return 'ready'
      if (opener.pending()) return 'starting'
      return opener.failed() ? 'unavailable' : 'idle'
    },
    active: () => !closing && exists() && owned() && claim() && !writerRefused(),
    async service() {
      if (closing || !exists() || !owned() || !claim()) return undefined
      try {
        return await started(false)
      } catch (error) {
        if (error instanceof HostBrainWriterBusy) return undefined
        throw error
      }
    },
    open: () => openOrCreate(),
    async enable() {
      const service = await openOrCreate()
      const { prefs } = await service.api.status()
      if (!prefs.enabled) await service.api.setPrefs({ ...prefs, enabled: true })
      return service
    },
    dispose() {
      closing ??= (async () => {
        try {
          const service = await opener.pending()?.catch(() => undefined)
          await service?.dispose()
        } finally {
          opener.forget()
          await writer.release()
          folder.release()
        }
      })()
      return closing
    },
  }
}
