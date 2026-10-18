import type { HostCapability } from '@phosphor/shared/remote-host'
import type { CallErrorCode } from '@phosphor/shared/host-protocol'
import type { HostStore } from '../lanes/store'

export type FeatureOutcome =
  { ok: true; data: unknown } | { ok: false; error: { code: CallErrorCode; message: string } }
export interface FeatureContext {
  store: Pick<HostStore, 'getLane' | 'listRepositories'>
  env: NodeJS.ProcessEnv
  home: string
  log(event: string, fields: Record<string, string | number>): void
}
export interface HostFeature {
  capability: HostCapability
  /** Exact method names, each `<namespace>.<name>`. */
  methods: readonly string[]
  call(method: string, params: unknown, authorized?: () => boolean): Promise<FeatureOutcome>
}
