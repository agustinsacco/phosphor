import type { LaneSessions } from './create'
import type { RuntimeLaneOptions, RuntimeLaneState } from './runtime-host/state'
import { command } from './runtime-host/command'
import * as lifecycle from './runtime-host/lifecycle'

export function createRuntimeLanes(options: RuntimeLaneOptions) {
  const context: RuntimeLaneState = { options, bindings: new Map() }
  const sessions: LaneSessions = {
    start: lifecycle.start.bind(null, context),
    attach: lifecycle.attach.bind(null, context),
    stop: lifecycle.stop.bind(null, context),
  }
  return {
    sessions,
    resumeLane: lifecycle.resumeLane.bind(null, context),
    deleteStop: lifecycle.deleteStop.bind(null, context),
    stopLane: lifecycle.stopLane.bind(null, context),
    command: command.bind(null, context),
    extensionUiResponse: options.runtime.extensionUiResponse,
  }
}
