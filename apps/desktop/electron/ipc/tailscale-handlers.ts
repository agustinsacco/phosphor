import { readTailscaleStatus } from '../hosts/tailscale-status'
import { handle } from './handle'

export function registerTailscaleHandlers(): void {
  handle('hosts:tailscaleStatus', () => readTailscaleStatus())
}
