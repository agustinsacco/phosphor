import type { BrainAgentMethod, BrainQuery, BrainSearchResult } from '@phosphor/shared/brain'
import type {
  SessionStartupRuntime,
  SessionMemoryAugmentation,
} from '@phosphor/session-runtime/pi/session-startup'
import type { BrainServiceOptions } from './service-types'
import type { DesktopMemoryClient } from './memory-client'
import type { BrainCapability, createBrainBridge } from './bridge'
import type { createBrainIndexer } from './indexer'
import { bounded, identifier, laneAuthority } from './authority'
import { attachBrainCapture } from './capture'

type Bridge = Awaited<ReturnType<typeof createBrainBridge>>
export function createBrainWorking(
  options: BrainServiceOptions,
  store: DesktopMemoryClient,
  bridge: Bridge,
  indexer: ReturnType<typeof createBrainIndexer>,
) {
  return new BrainWorking(options, store, bridge, indexer)
}
class BrainWorking {
  constructor(
    private readonly options: BrainServiceOptions,
    private readonly store: DesktopMemoryClient,
    private readonly bridge: Bridge,
    private readonly indexer: ReturnType<typeof createBrainIndexer>,
  ) {
    options.registry.on('disposed', this.disposed)
  }
  private readonly cleanups = new Map<string, () => void>()
  private readonly nativeIds = new Map<string, string>()
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
  ): Promise<void> => {
    await this.authority(capability)
    const runtimeId = capability.sessionId!
    const nativeId = this.nativeIds.get(runtimeId)
    if (!nativeId) throw new Error('Brain recipient identity unavailable')
    for (const sessionId of new Set([runtimeId, nativeId]))
      await this.store.recordDelivery({ sessionId, evidenceIds, claimIds })
  }
  invoke = async (capability: BrainCapability, method: BrainAgentMethod, raw: unknown) => {
    const bound = await this.authority(capability)
    const params = bounded(raw) as Record<string, unknown>
    if (!params || typeof params !== 'object') throw new Error('Invalid Brain request')
    if (method === 'read') {
      const evidence = await this.store.read(identifier(params.evidenceId as string), [bound.scope])
      if (evidence.branch !== null && evidence.branch !== bound.branch)
        throw new Error('Brain evidence branch unavailable')
      await this.delivery(capability, [evidence.id], [])
      return evidence
    }
    if (method !== 'search' && method !== 'brief') throw new Error('Unsupported Brain operation')
    const query = params as unknown as BrainQuery
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
    let cleanup = (): void => {
      grant?.revoke()
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
      onCreated: async (live) => {
        if (this.stopped || (await this.store.snapshot()).policyEpoch !== snapshot.policyEpoch) {
          grant?.revoke()
          return
        }
        grant?.bind(live.sessionId)
        const state = await live.client.request({ type: 'get_state' })
        if (!state.success || !state.data?.sessionId)
          throw new Error('Brain recipient identity unavailable')
        this.nativeIds.set(live.sessionId, state.data.sessionId)
        const detach = await attachBrainCapture(
          live,
          this.store,
          snapshot.policyEpoch,
          this.options.onError ?? (() => {}),
        )
        cleanup = () => {
          grant?.revoke()
          detach()
          this.nativeIds.delete(live.sessionId)
          this.cleanups.delete(live.sessionId)
        }
        this.cleanups.set(live.sessionId, cleanup)
      },
      dispose() {
        cleanup()
      },
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
