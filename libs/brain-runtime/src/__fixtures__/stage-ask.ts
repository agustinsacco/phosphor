import { vi } from 'vitest'
import type { StageAsk } from '../stage-types'

export function trackAsk(run:StageAsk = async()=>{throw new Error('Unexpected model call')}) {
  const spy=vi.fn()
  const ask:StageAsk=(...args)=>{spy(...args);return run(...args)}
  return {ask,spy}
}
