import { parseUsagePingPatch } from '@shared/usage-ping'
import { usagePing } from '../usage/desktop'
import { handle } from './handle'

/**
 * Settings → Advanced → Privacy and the one-time notice. The renderer reads the
 * state once per window load, which also starts main's daily schedule (a no-op
 * in dev, E2E, or with DO_NOT_TRACK set).
 */
export function registerUsagePingHandlers(): void {
  handle('app:usagePing', () => {
    const service = usagePing()
    service.start()
    return service.settings()
  })
  handle('app:setUsagePing', (_event, patch) => {
    const parsed = parseUsagePingPatch(patch)
    if (!parsed) throw new Error('Invalid usage ping setting.')
    return usagePing().set(parsed)
  })
}
