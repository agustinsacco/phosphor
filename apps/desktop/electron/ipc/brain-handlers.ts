import type { BrainInvokeMap } from '@phosphor/shared/brain'
import type { BrainApi, BrainService } from '@phosphor/brain-runtime/service-types'
import { bounded } from '@phosphor/brain-runtime/authority'
import { handle } from './handle'

type BrainCommands = {
  [K in keyof BrainInvokeMap]: (
    ...args: BrainInvokeMap[K]['args']
  ) => Promise<BrainInvokeMap[K]['result']>
}

/** The wire vocabulary belongs to Desktop, not the Node backend. */
function commands(api: BrainApi): BrainCommands {
  return {
    'brain:status': api.status,
    'brain:setPrefs': api.setPrefs,
    'brain:download': api.download,
    'brain:removeModel': api.removeModel,
    'brain:search': api.search,
    'brain:read': api.read,
    'brain:evidence': api.evidence,
    'brain:graph': api.graph,
    'brain:process': api.process,
    'brain:learnPreview': api.learnPreview,
    'brain:learn': api.learn,
    'brain:learningJobs': api.learningJobs,
    'brain:learningDetail': api.learningDetail,
    'brain:cancel': api.cancel,
    'brain:review': api.review,
    'brain:correct': api.correct,
    'brain:forget': api.forget,
    'brain:transcript': api.transcript,
  }
}

/** Desktop review/settings only. Lazy acquisition keeps failed startup retryable. */
export function registerBrainHandlers(service: BrainService | (() => Promise<BrainService>)): void {
  const invoke = async <K extends keyof BrainInvokeMap>(
    channel: K,
    ...args: BrainInvokeMap[K]['args']
  ): Promise<BrainInvokeMap[K]['result']> => {
    const { api } = typeof service === 'function' ? await service() : service
    const method = commands(api)[channel] as (
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
  handle('brain:evidence', (_event, scope, cursor) => invoke('brain:evidence', scope, cursor))
  handle('brain:graph', (_event, id) => invoke('brain:graph', id))
  handle('brain:process', (_event, scope, consent) =>
    invoke('brain:process', scope, bounded(consent)),
  )
  handle('brain:learnPreview', (_event, target) => invoke('brain:learnPreview', bounded(target)))
  handle('brain:learn', (_event, target, consent) =>
    invoke('brain:learn', bounded(target), bounded(consent)),
  )
  handle('brain:learningJobs', (_event, scope) => invoke('brain:learningJobs', scope))
  handle('brain:learningDetail', (_event, id) => invoke('brain:learningDetail', id))
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
