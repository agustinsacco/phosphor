import { hostPlatform } from './shortcuts'

/**
 * What the UI calls the machine this client runs on, in its platform's own word:
 * "This Mac", "This PC" or "This computer". Every place that names the local
 * machine uses this, so Linux and Windows never read "This Mac".
 */
export function localMachineLabel(platform: string = hostPlatform()): string {
  return platform === 'darwin' ? 'This Mac' : platform === 'win32' ? 'This PC' : 'This computer'
}
