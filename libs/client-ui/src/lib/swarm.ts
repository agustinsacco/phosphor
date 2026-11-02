import { SWARM_COMMAND } from '@phosphor/pi-extensions/swarm'
import { runExtensionCommand } from './extensionCommand'

export function requestSwarm(sessionId: string, enabled: boolean): Promise<void> {
  return runExtensionCommand(sessionId, SWARM_COMMAND, enabled ? 'on' : 'off', {
    control: 'Swarm',
    failed: 'Could not change Swarm authorization.',
  })
}
