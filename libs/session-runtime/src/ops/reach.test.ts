import { expectTypeOf, it } from 'vitest'
import type { OpsRunRequest } from '@phosphor/shared/host-protocol-ops'
import type { Reach, ReachBudget, ReachControlStage, ReachDirectory, ReachMachine } from './reach'

it('runs one OpsRunRequest per host, with no plan or run mode', () => {
  expectTypeOf<Parameters<Reach['run']>>().toEqualTypeOf<
    [
      hostId: string,
      request: OpsRunRequest,
      options: ReachBudget & { readonly write: boolean; readonly target?: ReachMachine },
    ]
  >()
  expectTypeOf<'mode'>().not.toExtend<keyof Parameters<Reach['run']>[2]>()
  expectTypeOf<Extract<ReachDirectory, { available: false }>['reason']>().toEqualTypeOf<
    'signed-out' | 'control-old' | 'reach-off' | 'account-disabled' | ReachControlStage
  >()
})
