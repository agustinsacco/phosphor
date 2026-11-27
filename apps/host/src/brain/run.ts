import { embeddingPlatformSupported } from '@phosphor/brain-runtime/embedding/model-manifest'
import type { BrainEmbeddings } from '@phosphor/brain-runtime/embedding/embedding-port'
import type {
  BrainAgentHost,
  BrainSearchPort,
  BrainServiceOptions,
} from '@phosphor/brain-runtime/types'
import { readLocalBrainSelection } from '@phosphor/session-runtime/brain/local-owner'
import { createProductionBrainAgent } from './agent/production'
import { hostBrainAgentGuard } from './agent/profile'
import { createBrainHandoverNativePorts } from '../brain-handover/native-ports'
import { bindBrainSurface, type BrainSurfaceBinding } from '../api/brain-adapter'
import { hostBrainAdmission, type HostBrainAdmission } from '../brain-handover/gate'
import { pinBrainCompatibility } from '../update/brain-compatibility'
import type { HostStore } from '../lanes/store'
import type { HostClaudeAccounts } from '../providers/accounts'
import type { HostRuntime } from '../session/runtime'

import { createHostBrainEmbeddings } from './embedding-service'
import { createHostBrainInventory } from './inventory'
import { createHostLaneRecall, type HostLaneRecall } from './lane-recall'
import { resolvePackagedBrainRuntime } from './packaged-runtime'
import { createHostBrain, hostBrainLaneFolder, type HostBrain } from './runtime'
import { createHostBrainLanes } from './runtime-lanes'
import { createHostBrainSearch } from './search-service'
import { createHostBrainSurfaceHandlers } from './surface-runtime'
import type { BrainSurfaceAgent } from './surface-service'

export { HOST_BRAIN_OFF_GENERATION } from './surface-runtime'

/** What Brain Agent's owner builds once the Brain first opens: its turns and its page. */
export interface HostBrainAgentPorts {
  runtime: HostRuntime
  /** `<state>/brain/Brain`, the reserved lane's real folder once it exists. */
  laneFolder: string
  stateDirectory: string
}
export type HostBrainAgentFactory = (ports: HostBrainAgentPorts) => {
  host: BrainAgentHost
  surface: BrainSurfaceAgent
}

/** What other owners hand the Host's Brain. */
export interface HostBrainCollaborators {
  agent?: HostBrainAgentFactory
}

/** The packaged worker entries, from `resolvePackagedBrainRuntime`. */
export type HostBrainWorkers = NonNullable<ReturnType<typeof resolvePackagedBrainRuntime>>

/** The Host's Brain, its lanes' recall and the one surface binding both listeners serve. */
export interface RunBrain {
  brain: HostBrain
  recall: HostLaneRecall
  surface: BrainSurfaceBinding
  curator: ReturnType<typeof createProductionBrainAgent>['contribution']
  handover: ReturnType<typeof createBrainHandoverNativePorts>
}

export interface RunBrainPorts extends HostBrainCollaborators {
  stateDirectory: string
  resourceRoot: string
  packaged: HostBrainWorkers
  pi: { binaryPath: string; prefixArgs: string[] }
  env: Record<string, string>
  accounts?: Pick<HostClaudeAccounts, 'accountForSpawn'>
  /** The lane store, for the Brain's inventory of ordinary lanes. */
  store: Pick<HostStore, 'getLane' | 'sessionLane'>
  sessionsRoot: string
  /** Late-bound: the runtime exists after the Brain does. */
  busy(sessionPath: string): boolean | undefined
  runtime?(): HostRuntime | undefined
  /** A local owner socket and Desktop share the initial selection; standalone Hosts do not. */
  local?: boolean
  /** Standalone hosts pin their selected release at first open, not at startup. */
  beforeOpen?(): void
  log(message: string, data?: Record<string, unknown>): void
  /** Defaults to the handover's on-disk claim; tests substitute a move. */
  admission?(stateDirectory: string): HostBrainAdmission
  /** Tests only: no worker processes, no provider. */
  embeddings?: (directory: string) => BrainEmbeddings
  openSearch?: (path: string) => BrainSearchPort
  runModelCall?: BrainServiceOptions['runModelCall']
}

function brainOwnership(ports: RunBrainPorts) {
  const admission = () => {
    try {
      return (ports.admission ?? hostBrainAdmission)(ports.stateDirectory).state
    } catch {
      return 'unreadable' as const
    }
  }
  const nativeOwned = (state = admission()) =>
    state === 'imported' ||
    (state === 'open' && (!ports.local || readLocalBrainSelection(ports.stateDirectory) === 'host'))
  return { admission, nativeOwned }
}

/** Builds nothing on disk and starts no worker: a fresh Host's Brain stays off. */
export function createRunBrain(ports: RunBrainPorts): RunBrain {
  const workerLog = (message: string) => ports.log('Brain worker', { message })
  const { admission, nativeOwned } = brainOwnership(ports)
  const production = createProductionBrainAgent(
    ports.stateDirectory,
    ports.sessionsRoot,
    ports.log,
    async () => (await brain.service())?.curatorLaunch(),
    hostBrainAgentGuard(ports.resourceRoot),
  )
  const factory = ports.agent ?? production.agent
  let agent: ReturnType<HostBrainAgentFactory> | undefined
  const resolveAgent = (laneFolder: string) => {
    const runtime = ports.runtime?.()
    if (!agent && runtime)
      agent = factory({ runtime, laneFolder, stateDirectory: ports.stateDirectory })
    return agent
  }
  const brain: HostBrain = createHostBrain({
    stateDirectory: ports.stateDirectory,
    resourceRoot: ports.resourceRoot,
    lanes: createHostBrainLanes(ports),
    // Read at every write entry point: a move that claims the target stops the writer at once.
    migrationGuard: { owned: () => nativeOwned() },
    beforeOpen: ports.beforeOpen,
    ...(ports.runtime
      ? {
          agent: (laneFolder: string) => {
            const built = resolveAgent(laneFolder)
            if (!built) throw new Error('Brain Agent needs the Host runtime.')
            return built.host
          },
        }
      : {}),
    embeddings:
      ports.embeddings ??
      ((directory) =>
        createHostBrainEmbeddings(directory, ports.packaged.embeddingWorker, workerLog)),
    openSearch:
      ports.openSearch ??
      ((path) => createHostBrainSearch(path, ports.packaged.searchWorker, workerLog)),
    ...(ports.runModelCall ? { runModelCall: ports.runModelCall } : {}),
    log: ports.log,
  })
  const lanes = createHostBrainInventory({
    store: ports.store,
    sessionsRoot: ports.sessionsRoot,
    reserved: () => [hostBrainLaneFolder(ports.stateDirectory)],
  })
  const surface = bindBrainSurface(
    createHostBrainSurfaceHandlers({
      brain,
      lanes,
      agent: () =>
        brain.state() === 'ready' ? resolveAgent(brain.laneFolder)?.surface : undefined,
      mayCreate: () => nativeOwned('open') && admission() === 'open',
      supported: embeddingPlatformSupported(process.platform, process.arch),
    }),
  )
  const handover = createBrainHandoverNativePorts({
    resourceRoot: ports.resourceRoot,
    pi: ports.pi,
    sessionsRoot: ports.sessionsRoot,
    agentBinding: production.importBinding,
    log: () => ports.log('Brain handover worker'),
  })
  return {
    brain,
    recall: createHostLaneRecall(brain, ports.log),
    surface,
    curator: production.contribution,
    handover,
  }
}

/**
 * The Host's Brain on a qualified bundle, or undefined: an unqualified one serves no Brain, takes
 * over no lane and leaves Desktop's bridge as it was.
 */
export function qualifiedRunBrain(
  resourceRoot: string,
  ports: Omit<RunBrainPorts, 'packaged' | 'resourceRoot' | 'beforeOpen'> & {
    install: { home: string; uid: number | undefined }
  },
): RunBrain | undefined {
  const packaged = resolvePackagedBrainRuntime(resourceRoot)
  if (!packaged) return undefined
  return createRunBrain({
    ...ports,
    resourceRoot,
    packaged,
    beforeOpen: ports.local
      ? undefined
      : () => pinBrainCompatibility({ ...ports.install, resourceRoot }),
  })
}
