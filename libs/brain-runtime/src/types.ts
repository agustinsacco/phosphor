import type { BrainAgentMap, BrainAgentMethod, BrainInvokeMap } from '@phosphor/shared/brain'
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
  embeddings: BrainEmbeddings
  lanes: BrainLanes
  /** The guard extension every private call loads: it refuses all tool calls. */
  guardExtension: string
  /** Recall extension and skill handed to lane agents when recall is on. */
  recall: { extension: string; skill: string }
  /** Called whenever status changes (queue, download, review), so the UI can refresh. */
  onChange?: () => void
  log?: (message: string, data?: Record<string, unknown>) => void
  now?: () => number
}

/** What session startup adds to a lane when Brain and recall are on. */
export interface BrainRecallLaunch {
  env: Record<string, string>
  extensions: string[]
  skills: string[]
}

export interface BrainService {
  api: BrainApi
  /** Socket requests from lane agents; read-only. */
  agent<M extends BrainAgentMethod>(
    method: M,
    request: BrainAgentMap[M]['request'],
  ): Promise<BrainAgentMap[M]['result']>
  /** Undefined when Brain or recall is off. Never throws: recall must not block a lane. */
  recallLaunch(): Promise<BrainRecallLaunch | undefined>
  dispose(): Promise<void>
}
