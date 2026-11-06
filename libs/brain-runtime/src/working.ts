import type { BrainAgentMethod, BrainQuery, BrainSearchResult } from '@phosphor/shared/brain'
import type {
  SessionStartupRuntime,
  SessionMemoryAugmentation,
} from '@phosphor/session-runtime/pi/session-startup'
import type { BrainServiceOptions } from './service-types'
import type { BrainMemoryClient } from './memory-client'
import type { BrainCapability, createBrainBridge } from './bridge'
import type { createBrainIndexer } from './indexer'
import { bounded, brainQuery, fields, identifier, laneAuthority } from './authority'
import { attachBrainCapture, type BrainCaptureObserver } from './capture'

type Bridge = Awaited<ReturnType<typeof createBrainBridge>>
export function createBrainWorking(
  options: BrainServiceOptions,
  store: BrainMemoryClient,
  bridge: Bridge,
  indexer: ReturnType<typeof createBrainIndexer>,
) {
  return new BrainWorking(options, store, bridge, indexer)
}
class BrainWorking {
  constructor(
    private readonly options: BrainServiceOptions,
    private readonly store: BrainMemoryClient,
    private readonly bridge: Bridge,
    private readonly indexer: ReturnType<typeof createBrainIndexer>,
  ) {
    options.registry.on('disposed', this.disposed)
  }
  private readonly cleanups = new Map<string, () => void>()
  private stopped = false
  authority = async (capability: BrainCapability) => {
    const snapshot = await this.store.snapshot()
    const live = capability.sessionId ? this.options.registry.get(capability.sessionId) : undefined
    if (
      this.stopped ||
      !live ||
      live.owner ||
      !snapshot.prefs.enabled ||
      !snapshot.prefs.recall ||
      snapshot.policyEpoch !== capability.policyEpoch
    )
      throw new Error('Brain recall unavailable')
    const current = await laneAuthority(live.workspacePath)
    if (current.scope !== capability.scope || !snapshot.prefs.workspaces.includes(current.scope))
      throw new Error('Brain scope unavailable')
    return current
  }
  delivery = async (
    capability: BrainCapability,
    evidenceIds: string[],
    claimIds: string[],
    branch: string,
  ): Promise<void> => {
    if ((await this.authority(capability)).branch !== branch)
      throw new Error('Brain branch changed during delivery')
    const runtimeId = capability.sessionId!
    const live = this.options.registry.get(runtimeId)!
    const state = await live.client.request({ type: 'get_state' })
    const nativeId = state.success ? state.data?.sessionId : undefined
    if (!nativeId) throw new Error('Brain recipient identity unavailable')
    for (const sessionId of new Set([runtimeId, nativeId]))
      await this.store.recordDelivery({ sessionId, evidenceIds, claimIds })
    if ((await this.authority(capability)).branch !== branch)
      throw new Error('Brain branch changed during delivery')
  }
  invoke = async (capability: BrainCapability, method: BrainAgentMethod, raw: unknown) => {
    const bound = await this.authority(capability)
    const params = bounded(raw) as Record<string, unknown>
    if (!params || typeof params !== 'object') throw new Error('Invalid Brain request')
    if (method === 'read') {
      fields(params, ['evidenceId'])
      const evidence = await this.store.read(identifier(params.evidenceId as string), [bound.scope])
      if (evidence.branch !== null && evidence.branch !== bound.branch)
        throw new Error('Brain evidence branch unavailable')
      await this.delivery(capability, [evidence.id], [], bound.branch)
      return evidence
    }
    if (method !== 'search' && method !== 'brief') throw new Error('Unsupported Brain operation')
    const query = brainQuery(params as unknown as BrainQuery)
    if (
      (query.scopes && (query.scopes.length !== 1 || query.scopes[0] !== bound.scope)) ||
      (query.branch !== undefined && query.branch !== bound.branch)
    )
      throw new Error('Brain authority cannot be widened')
    const result: BrainSearchResult = await this.indexer.search(
      {
        ...query,
        branch: bound.branch,
        scopes: [bound.scope],
        ...(method === 'brief' ? { limit: 5, tokenBudget: 600 } : {}),
      },
      [bound.scope],
    )
    const after = await this.authority(capability)
    if (after.branch !== bound.branch) throw new Error('Brain branch changed during retrieval')
    await this.delivery(
      capability,
      result.results.flatMap((hit) => hit.evidence.map((item) => item.id)),
      result.results.map((hit) => hit.claim.id),
      bound.branch,
    )
    return result
  }
  private prepare: NonNullable<SessionStartupRuntime['memory']>['prepare'] = async (
    sessionOptions,
  ) => {
    if (this.stopped) return undefined
    const snapshot = await this.store.snapshot()
    if (!snapshot.prefs.enabled) return undefined
    let bound: Awaited<ReturnType<typeof laneAuthority>>
    try {
      bound = await laneAuthority(sessionOptions.workspacePath)
    } catch {
      return undefined
    }
    if (!snapshot.prefs.workspaces.includes(bound.scope)) return undefined
    const grant = snapshot.prefs.recall
      ? this.bridge.issue({
          kind: 'working',
          scope: bound.scope,
          policyEpoch: snapshot.policyEpoch,
        })
      : undefined
    let capture: BrainCaptureObserver | undefined
    let disabled = false
    let id: string | undefined
    const cleanup = (): void => {
      disabled = true
      grant?.revoke()
      capture?.()
      if (id) this.cleanups.delete(id)
    }
    const failed = (error: unknown): void => {
      cleanup()
      this.options.onError?.(error)
    }
    const augmentation: SessionMemoryAugmentation = {
      ...(grant
        ? {
            env: {
              PHOSPHOR_BRAIN_ENDPOINT: grant.connection.endpoint,
              PHOSPHOR_BRAIN_TOKEN: grant.connection.token,
            },
            extensions: [this.options.resources.workingExtension],
          }
        : {}),
      beforeInput: async (command) => (disabled ? undefined : capture?.beforeInput(command)),
      invalidateInput: cleanup,
      onCreated: async (live) => {
        id = live.sessionId
        try {
          if (
            disabled ||
            this.stopped ||
            (await this.store.snapshot()).policyEpoch !== snapshot.policyEpoch
          ) {
            cleanup()
            return
          }
          grant?.bind(live.sessionId)
          capture = await attachBrainCapture(live, this.store, snapshot.policyEpoch, failed)
          if (disabled || this.stopped) {
            cleanup()
            return
          }
          this.cleanups.set(live.sessionId, cleanup)
        } catch (error) {
          failed(error)
        }
      },
      dispose: cleanup,
    }
    return augmentation
  }
  private disposed = ({ sessionId }: { sessionId: string }): void => {
    this.cleanups.get(sessionId)?.()
  }
  memory = { prepare: this.prepare }
  dispose() {
    this.stopped = true
    this.options.registry.off('disposed', this.disposed)
    for (const cleanup of this.cleanups.values()) cleanup()
    this.cleanups.clear()
  }
}
