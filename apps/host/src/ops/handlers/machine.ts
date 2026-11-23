import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { dataResult, op } from '@phosphor/session-runtime/ops/results'
import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import { runServiceUpdate } from '../service-update'
import { HOST_VERSION } from '../../version'
import type { DaemonHandlerDeps } from './index'
import { laneCall } from './lane-target'

/** Catalog op → the lane service's machine call, which reads pi's own inventory. */
const INVENTORY = {
  'machine.models': 'machine.models',
  'machine.providers': 'machine.providers',
  'machine.commands': 'machine.commands',
  'machine.usage': 'machine.claudeUsage',
} as const

/**
 * The machine's own ops. `machine.doctor` refreshes the daemon's login-shell
 * environment, which new lanes then start with; a failed capture keeps the
 * last good one. `service.update` stages, pauses every lane, then applies.
 */
export function machineHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  const inventory = Object.fromEntries(
    Object.entries(INVENTORY).map(([name, method]) => [
      name,
      op(async () => dataResult(await laneCall(deps.lanes, method, {}))),
    ]),
  )
  return {
    ...inventory,
    'machine.status': op(() => {
      const lanes = deps.store.listLanes()
      const summaries = lanes.flatMap((l) => deps.laneRuntime?.summaryFor(l.laneId) ?? [])
      const live = summaries.filter((s) => s.activity !== 'stopped' && s.activity !== 'failed')
      return dataResult({
        hostVersion: HOST_VERSION,
        lanes: {
          total: lanes.length,
          live: live.length,
          working: live.filter((s) => s.activity === 'working').length,
        },
        pause: deps.pauseState?.() ?? { kind: 'none' },
      })
    }),
    'machine.doctor': op(async () => {
      const shell = deps.shellEnvironment
      if (!shell)
        return {
          text: 'This machine does not read a login-shell environment.',
          data: { shellEnvironment: 'not-used' },
        }
      const refreshed = await shell.refresh()
      return refreshed
        ? {
            text: 'Read the login-shell environment again. New lanes start with it.',
            data: { shellEnvironment: 'refreshed' },
          }
        : {
            text: 'Could not read the login-shell environment. Lanes keep the last one that worked.',
            data: { shellEnvironment: 'unavailable' },
          }
    }),
    'service.update': op(() => {
      const update = deps.serviceUpdate
      if (!update)
        throw new OpRefusal(
          'unavailable',
          'This Phosphor service cannot update itself: it was not installed from a release.',
        )
      return runServiceUpdate(update)
    }),
  }
}
