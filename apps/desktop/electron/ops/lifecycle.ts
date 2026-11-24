import type { OpsDispatcher } from '@phosphor/session-runtime/ops/types'

let current: OpsDispatcher | undefined
/** Ordinary dialog answers and idle events do not open the audit database. */
export const activeDesktopOps = () => current
export function installDesktopOps(dispatcher: OpsDispatcher) {
  current = dispatcher
}
