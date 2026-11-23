import type { OpsRunResult } from '@shared/host-protocol-ops'
import { handle } from './handle'

/** What `ops:run` answers until This Mac and the Host bindings serve catalog ops. */
export const OPS_NOT_SERVED: OpsRunResult = {
  status: 'denied',
  code: 'unsupported',
  text: 'This version of Phosphor does not run agent ops yet.',
}

/** Agent control as a surface: one catalog op on This Mac or a Host. */
export function registerOpsHandlers(): void {
  handle('ops:run', () => OPS_NOT_SERVED)
}
