import { expectTypeOf, it } from 'vitest'
import type { OpsRunRequest } from '@phosphor/shared/host-protocol-ops'
import type { Reach, ReachDirectory } from './reach'

it('runs one OpsRunRequest per host, with no plan or run mode', () => {
  expectTypeOf<Parameters<Reach['run']>>().toEqualTypeOf<
    [
      hostId: string,
      request: OpsRunRequest,
      options: { readonly write: boolean; readonly signal?: AbortSignal },
    ]
  >()
  expectTypeOf<'mode'>().not.toExtend<keyof Parameters<Reach['run']>[2]>()
  expectTypeOf<Extract<ReachDirectory, { available: false }>['reason']>().toEqualTypeOf<
    'signed-out' | 'control-old' | 'offline' | 'reach-off' | 'account-disabled'
  >()
})
