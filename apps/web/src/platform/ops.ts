import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { BrowserHandlers } from './handlers'

/** What `ops:run` answers in the browser until the Host binding serves catalog ops. */
export const BROWSER_OPS_NOT_SERVED: OpsRunResult = {
  status: 'denied',
  code: 'unsupported',
  text: 'This version of Phosphor does not run agent ops yet.',
}

/** Agent control as a surface: one catalog op on a Host. The browser has no This Mac. */
export function opsHandlers() {
  return {
    'ops:run': () => BROWSER_OPS_NOT_SERVED,
  } satisfies Partial<BrowserHandlers>
}
