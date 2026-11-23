import { op } from '@phosphor/session-runtime/ops/results'
import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import type { DaemonHandlerDeps } from './index'

/**
 * The machine's own ops. `machine.doctor` refreshes the daemon's login-shell
 * environment, which new lanes then start with; a failed capture keeps the
 * last good one. H4 adds the rest (listed in `PENDING_HANDLERS`).
 */
export function machineHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  return {
    'machine.doctor': op(async () => {
      const shell = deps.shellEnvironment
      if (!shell)
        return {
          text: 'This machine does not read a login-shell environment.',
          data: { shellEnvironment: 'not-used' },
        }
      const refreshed = await shell.refresh()
      return refreshed
        ? {
            text: 'Read the login-shell environment again. New lanes start with it.',
            data: { shellEnvironment: 'refreshed' },
          }
        : {
            text: 'Could not read the login-shell environment. Lanes keep the last one that worked.',
            data: { shellEnvironment: 'unavailable' },
          }
    }),
  }
}
