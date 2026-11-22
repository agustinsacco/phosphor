import { hostPlatform } from './shortcuts'

/**
 * What the UI calls the machine this client runs on, in its platform's own word:
 * "This Mac" or "This computer". Every place that names the local machine uses
 * this, so Linux never reads "This Mac".
 */
export function localMachineLabel(platform: string = hostPlatform()): string {
  return platform === 'darwin' ? 'This Mac' : 'This computer'
}
