import type { LocalServiceInstall } from '@phosphor/shared/ipc'
import type { DaemonInstallStatus } from '../daemon/install'

/**
 * The background service install as Settings shows it while This Mac is in-app. Before the
 * installer runs there is nothing to say; after, only the state, step, version and reason.
 */
export function installView(status: DaemonInstallStatus): LocalServiceInstall | undefined {
  switch (status.state) {
    case 'off':
    case 'idle':
      return undefined
    case 'checking':
      return { state: 'checking' }
    case 'installing':
      return {
        state: 'installing',
        step: status.step,
        ...(status.version && { version: status.version }),
      }
    case 'installed':
      return { state: 'installed', version: status.version }
    case 'waiting':
    case 'blocked':
    case 'failed':
      return { state: status.state, detail: status.detail }
  }
}

/** A listener that logs each change of the install once; `phosphor.log` then tells the story. */
export function logInstallChanges(
  log: (event: string, data: Record<string, unknown>) => void,
): (status: DaemonInstallStatus) => void {
  let last = ''
  return (status) => {
    const view = installView(status)
    const data =
      view && status.state === 'installed' ? { ...view, launcher: status.launcher } : view
    const key = JSON.stringify(data ?? { state: status.state })
    if (key === last) return
    last = key
    log('service install', { ...(data ?? { state: status.state }) })
  }
}
