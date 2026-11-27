import { brainContribution } from '@phosphor/session-runtime/pi/contributions/brain'
import type { SpawnContribution } from '@phosphor/session-runtime/pi/spawn-contributions'
import type { HostLaneRecall } from '../../brain/lane-recall'
import type { AppServices } from '../app-services'

/** Only ordinary lanes receive recall. The legacy bridge serves them until Host cutover. */
export function createBrainContribution(brain: {
  appServices?: AppServices
  resourceRoot: string
  native?: HostLaneRecall
}): SpawnContribution {
  const native = brain.native
  const recall = brainContribution(async (workspacePath) =>
    native?.active()
      ? native.resources(workspacePath)
      : brain.appServices?.resources(brain.resourceRoot),
  )
  return {
    ...recall,
    spawn: (execution, policy) =>
      execution.reserved ? undefined : recall.spawn(execution, policy),
    attach(session) {
      if (session.reserved) return
      const piSessionId = () => session.client.piSessionId
      const forget = [
        brain.appServices?.attachLane(session.sessionId, session.workspacePath, piSessionId),
        native?.attachLane(session.sessionId, session.workspacePath, piSessionId),
      ]
      session.client.once('exit', () => forget.forEach((release) => release?.()))
    },
  }
}
