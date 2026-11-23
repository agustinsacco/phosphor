import { brainContribution } from '@phosphor/session-runtime/pi/contributions/brain'
import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'
import type { AppServices } from '../app-services'

/** The recall preference persists when Desktop disconnects; the port and briefing refs do not. */
export function createBrainContribution(brain: {
  appServices: AppServices
  resourceRoot: string
}): SpawnContribution {
  return {
    ...brainContribution(async () => brain.appServices.resources(brain.resourceRoot)),
    attach(session) {
      const forget = brain.appServices.attachLane(session.sessionId, session.workspacePath)
      session.client.once('exit', forget)
    },
  }
}
