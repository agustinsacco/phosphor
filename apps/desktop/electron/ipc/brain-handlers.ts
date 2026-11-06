import type { BrainInvokeMap } from '@phosphor/shared/brain'
import type { BrainService } from '../brain/service-types'
import { bounded } from '../brain/authority'
import { handle } from './handle'

/** Desktop review/settings only. Lazy acquisition keeps failed startup retryable. */
export function registerBrainHandlers(service: BrainService | (() => Promise<BrainService>)): void {
  const invoke = async <K extends keyof BrainInvokeMap>(
    channel: K,
    ...args: BrainInvokeMap[K]['args']
  ): Promise<BrainInvokeMap[K]['result']> => {
    const { ui } = typeof service === 'function' ? await service() : service
    const method = ui[channel] as (
      ...args: BrainInvokeMap[K]['args']
    ) => Promise<BrainInvokeMap[K]['result']>
    return method(...args)
  }
  handle('brain:status', () => invoke('brain:status'))
  handle('brain:setPrefs', (_event, prefs) => invoke('brain:setPrefs', bounded(prefs)))
  handle('brain:download', (_event, acceptTerms) => invoke('brain:download', acceptTerms))
  handle('brain:removeModel', () => invoke('brain:removeModel'))
  handle('brain:search', (_event, query) => invoke('brain:search', bounded(query)))
  handle('brain:read', (_event, id) => invoke('brain:read', id))
  handle('brain:graph', (_event, id) => invoke('brain:graph', id))
  handle('brain:process', (_event, scope, consent) =>
    invoke('brain:process', scope, bounded(consent)),
  )
  handle('brain:cancel', (_event, id) => invoke('brain:cancel', id))
  handle('brain:review', (_event, id, approve, revision) =>
    invoke('brain:review', id, approve, bounded(revision)),
  )
  handle('brain:correct', (_event, id, correction, revision) =>
    invoke('brain:correct', id, bounded(correction), bounded(revision)),
  )
  handle('brain:forget', (_event, ids) => invoke('brain:forget', bounded(ids)))
  handle('brain:transcript', (_event, id) => invoke('brain:transcript', id))
}
