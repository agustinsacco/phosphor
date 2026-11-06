import type { BrainInvokeMap, BrainModel } from '@phosphor/shared/brain'
import type { createSessionService } from '@phosphor/session-runtime/pi/session-service'
import type { SessionRegistry, LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type { SessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import type { SessionStartupRuntime } from '@phosphor/session-runtime/pi/session-startup'
import type { BrainEmbeddings } from './embedding-port'

export type BrainUI = {
  [K in keyof BrainInvokeMap]: (
    ...args: BrainInvokeMap[K]['args']
  ) => Promise<BrainInvokeMap[K]['result']>
}
export interface BrainServiceOptions {
  directory: string
  memoryWorkerPath: string
  embeddings: BrainEmbeddings
  resources: { workingExtension: string; processorExtension: string }
  sessions: Pick<ReturnType<typeof createSessionService>, 'create' | 'disposeBrain'>
  registry: Pick<SessionRegistry, 'get' | 'list' | 'on' | 'off'>
  sessionPaths: SessionPathRuntime
  processor: {
    resolve(model: BrainModel): Promise<{
      binaryPath: string
      prefixArgs?: string[]
      version: string
      env: Record<string, string>
    }>
    /** Audited nonce/job-bound extension handshake; must fail closed. No inference. */
    verifyTools(live: LiveSession): Promise<void>
  }
  onError?: (error: unknown) => void
}
export interface BrainService {
  ui: BrainUI
  memory: NonNullable<SessionStartupRuntime['memory']>
  dispose(): Promise<void>
}
