import type {
  BrainAgentMap,
  BrainAgentMethod,
  BrainInvokeMap,
  BrainJob,
  BrainSnapshot,
} from '@phosphor/shared/brain'
import type { BrainOpsPort, LaneFacts } from '@phosphor/session-runtime/ops/types'
import type { BrainSearch, BrainStore } from '@phosphor/memory-engine/types'
import type { runModelCall } from './model-call'
import type { BrainEmbeddings } from './embedding/embedding-port'

export type BrainSearchPort = {
  [K in keyof BrainSearch]: (
    ...args: Parameters<BrainSearch[K]>
  ) => Promise<Awaited<ReturnType<BrainSearch[K]>>>
}

/** The IPC commands without their `brain:` prefix. Desktop's handlers call these. */
export type BrainApi = {
  [K in keyof BrainInvokeMap as K extends `brain:${infer M}` ? M : never]: (
    ...args: BrainInvokeMap[K]['args']
  ) => Promise<BrainInvokeMap[K]['result']>
}

export type BrainSavedSource = Pick<BrainJob, 'sessionId' | 'sessionPath'>
export type BrainMutationCheck = (state: BrainSnapshot, source?: BrainSavedSource) => void

export interface BrainSurfaceRuntime {
  readonly api: BrainApi
  /** Creates an owner-local API with checks at each actual write, not a status preflight. */
  guarded(check: BrainMutationCheck): Omit<BrainApi, 'tell'>
  job(id: string): BrainJob | undefined
  /** Authorizes exact stored provenance before loading any transcript. */
  evidence(
    id: string,
    canReadSource: (source: BrainSavedSource) => boolean,
  ): ReturnType<BrainApi['extraction']>
}

/** How to start pi for a private model call: the lane's own binary, env and account. */
export interface ModelLaunch {
  binaryPath: string
  prefixArgs: string[]
  env: Record<string, string>
}

/** What the host app knows about lanes that the session file does not say. */
export interface BrainLanes {
  /** True while the lane's agent is working; extraction waits until this turns false. */
  busy(sessionPath: string): boolean
  launch(sessionPath: string): Promise<ModelLaunch>
}

export interface BrainServiceOptions {
  /** `<userData>/brain`. Holds brain.sqlite, the model and short-lived call directories. */
  directory: string
  /** Opens `<directory>/brain.sqlite`; Desktop passes `openBrainStore` with its SQLite. */
  openStore: (path: string) => BrainStore
  openSearch: (path: string) => BrainSearchPort
  /** Injectable model runner; tests never launch a provider. */
  runModelCall?: typeof runModelCall
  /** Abortable wait before the single provider/transport retry. */
  retryDelay?: (ms: number, signal: AbortSignal) => Promise<void>
  embeddings: BrainEmbeddings
  lanes: BrainLanes
  /** The guard extension every private call loads: it refuses all tool calls. */
  guardExtension: string
  /** Recall extension and skill handed to lane agents when recall is on. */
  recall: { extension: string; skill: string }
  /** Brain Agent's extension and skill, handed to lanes in the Brain folder instead of recall. */
  curator?: { extension: string; skill: string }
  /** Runs Brain Agent's turns in the Brain lane. Absent where no Brain lane can run. */
  agent?: BrainAgentHost
  /** Called whenever status changes (queue, download, saved reads), so the UI can refresh. */
  onChange?: () => void
  log?: (message: string, data?: Record<string, unknown>) => void
  now?: () => number
}

/** How one Defrag turn in the Brain lane ended. */
export interface BrainAgentTurn {
  outcome: 'finished' | 'stopped' | 'failed'
  error: string | null
  sessionPath: string | null
  /** The Brain lane's AGENTS.md changed during the turn. */
  rulesChanged: boolean
}
/** What the Brain lane tells Defrag while its turn gets going. */
export interface BrainAgentTurnHooks {
  /** The lane's transcript, as soon as it is known. */
  opened(sessionPath: string | null): void
  /**
   * Any turn the owner had running in the lane has settled, and Defrag's message goes next:
   * Brain Agent's changes belong to the run from now until the turn ends.
   */
  sending(): void
}
/**
 * Who the Brain lane's running turn acts for, on a Host: a Defrag run, or the person (controller)
 * whose message started it. Bound to that one turn: it never carries into a later one.
 */
export interface BrainAgentTurnGate {
  readonly kind: 'defrag' | 'controller'
  /** Still that same turn, and a controller still holds the authority they started it with. */
  admit(): boolean
}
/** Desktop owns the Brain lane; the runtime only asks it for one turn at a time. */
export interface BrainAgentHost {
  /** Real path of the Brain lane's folder. Brain never reads lanes there. */
  folder: string
  /**
   * Sends `message` as an ordinary prompt in the Brain lane, starting or resuming the lane, and
   * resolves when that turn ends. It first waits for a turn the owner has running there, never
   * interrupting it. Aborting `signal` stops the turn (or the wait) and resolves `stopped`.
   */
  turn(message: string, signal: AbortSignal, hooks: BrainAgentTurnHooks): Promise<BrainAgentTurn>
  /**
   * Sends `message` as an ordinary prompt in the Brain lane, owned by no run: opens the lane,
   * waits for a turn already running there to settle, and resolves once pi accepts the prompt.
   */
  tell(message: string): Promise<{ sessionPath: string | null }>
  /**
   * The Host's reserved lane only: the gate of the turn running now, or null when no turn of
   * known identity runs. When present, Brain Agent's tools answer only under it. Desktop's lane
   * has none and keeps its owner-only behaviour.
   */
  turnGate?(): BrainAgentTurnGate | null
}

/** What session startup adds to a lane when Brain and recall are on. */
export interface BrainRecallLaunch {
  extensions: string[]
  skills: string[]
}

/** The Brain lane's launch, the only one with a connection: the private bridge and curator token. */
export interface BrainCuratorLaunch extends BrainRecallLaunch {
  connection: { endpoint: string; token: string }
}

export interface BrainService extends BrainSurfaceRuntime {
  /** Allocate once per live lane; discard the port (and its briefing refs) when that lane ends. */
  forLane(lane: Pick<LaneFacts, 'cwd' | 'title'> & { readonly sessionId: string }): BrainOpsPort
  /**
   * Host lane bridge entry. Only search and flag are available. Brain Agent's methods require
   * its separate curator connection. `signal` aborts when the asker hangs up.
   */
  agent<M extends BrainAgentMethod>(
    method: M,
    request: BrainAgentMap[M]['request'],
    signal?: AbortSignal,
  ): Promise<BrainAgentMap[M]['result']>
  /** Undefined when Brain or recall is off. Never throws: recall must not block a lane. */
  recallLaunch(): Promise<BrainRecallLaunch | undefined>
  /**
   * The Brain lane's launch: the curator token, the brain-curator extension and the brain-agent
   * skill. Undefined when Brain is off or no curator extension is configured. Never throws.
   */
  curatorLaunch(): Promise<BrainCuratorLaunch | undefined>
  dispose(): Promise<void>
}
