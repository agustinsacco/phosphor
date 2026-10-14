import { readTailscaleStatus } from '../hosts/tailscale-status'
import { getPrefs, setTailscaleDiscovery } from '../store'
import { handle } from './handle'

export function registerTailscaleHandlers(): void {
  handle('hosts:tailscaleStatus', async () => {
    const enabled = getPrefs().tailscaleDiscovery === true
    const status = await readTailscaleStatus(enabled)
    // An opt-out while the command was running must also suppress its result.
    return getPrefs().tailscaleDiscovery === true
      ? status
      : { ...status, discovery: false, peers: [] }
  })
  handle('hosts:setTailscaleDiscovery', (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid discovery preference')
    setTailscaleDiscovery(enabled)
  })
}
