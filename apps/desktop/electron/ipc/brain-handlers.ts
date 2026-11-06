import type { BrainService } from '../brain/service-types'
import { bounded } from '../brain/authority'
import { handle } from './handle'

/** Desktop review/settings only. No worker methods or lifecycle controls cross IPC. */
export function registerBrainHandlers(service: BrainService): void {
  const { ui } = service
  handle('brain:status', () => ui['brain:status']())
  handle('brain:setPrefs', (_event, prefs) => ui['brain:setPrefs'](bounded(prefs)))
  handle('brain:download', (_event, acceptTerms) => ui['brain:download'](acceptTerms))
  handle('brain:removeModel', () => ui['brain:removeModel']())
  handle('brain:search', (_event, query) => ui['brain:search'](bounded(query)))
  handle('brain:read', (_event, id) => ui['brain:read'](id))
  handle('brain:graph', (_event, id) => ui['brain:graph'](id))
  handle('brain:process', (_event, scope, consent) => ui['brain:process'](scope, bounded(consent)))
  handle('brain:cancel', (_event, id) => ui['brain:cancel'](id))
  handle('brain:review', (_event, id, approve, revision) =>
    ui['brain:review'](id, approve, bounded(revision)),
  )
  handle('brain:correct', (_event, id, correction, revision) =>
    ui['brain:correct'](id, bounded(correction), bounded(revision)),
  )
  handle('brain:forget', (_event, ids) => ui['brain:forget'](bounded(ids)))
  handle('brain:transcript', (_event, id) => ui['brain:transcript'](id))
}
