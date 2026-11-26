import type { HostCapability } from '@phosphor/shared/remote-host'
import type { CallErrorCode, HostResourceChange } from '@phosphor/shared/host-protocol'
import type { HostStore } from '../lanes/store'

export type FeatureOutcome =
  { ok: true; data: unknown } | { ok: false; error: { code: CallErrorCode; message: string } }
export interface FeatureContext {
  store: Pick<HostStore, 'getLane' | 'listRepositories'>
  env: NodeJS.ProcessEnv
  home: string
  resourceChanged?(change: HostResourceChange): void
  log(event: string, fields: Record<string, string | number>): void
}
export interface HostFeature {
  capability: HostCapability
  /** Exact method names, each `<namespace>.<name>`. */
  methods: readonly string[]
  /** Its calls act for the calling client, which the connection's grant names. */
  clientScoped?: true
  call(
    method: string,
    params: unknown,
    authorized?: () => boolean,
    clientId?: string,
    signal?: AbortSignal,
  ): Promise<FeatureOutcome>
}
