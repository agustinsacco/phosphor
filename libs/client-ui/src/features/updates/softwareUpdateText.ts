import type { MachineUpdateState } from './machineUpdateState'

function offerLine(state: MachineUpdateState): string {
  const { available } = state
  return available
    ? state.availableFrom === 'host'
      ? `Version ${available} is available.`
      : `A newer version (${available}) runs on another machine.`
    : (state.can.why ?? 'Check for the newest signed release.')
}

function updateLine(state: MachineUpdateState): string | undefined {
  const { run, to, label, installed, available } = state
  if (!run) return offerLine(state)
  if (!run.settled) {
    if (run.step === 'downloading')
      return `Downloading and verifying${available ? ` ${available}` : ' the release'}…`
    if (run.step === 'restarting')
      return `Restarting${to ? ` on ${to}` : ''}. This usually takes under a minute.`
    if (run.step === 'health') return 'Checking that the service is back…'
    return undefined
  }
  switch (run.finish) {
    case 'updated':
      return `Updated to ${to}. Lanes continue on their next message.`
    case 'rolled-back':
      return `${to ?? 'The update'} didn’t pass its health check, so ${label} is back on ${installed ?? 'the previous version'}.`
    case 'still-working':
      return 'Lanes were still working. Nothing changed.'
    case 'cancelled':
      return 'Update cancelled. Nothing changed.'
    case 'download':
      return 'Couldn’t download and verify the update. Nothing changed.'
    case 'not-back':
      return `${label} hasn’t come back after 4 minutes. It may still be restarting.`
    case 'current':
      return 'Already up to date.'
    case 'apply':
      return `Couldn’t apply the update. ${installed ? `Still on ${installed}.` : 'Check the service connection.'}`
    case 'refused':
      return run.details?.includes('not installed from a release')
        ? 'This service is not installed from a release and cannot update itself.'
        : 'The service couldn’t start the update. Nothing changed.'
  }
}

export function waitingLine(state: MachineUpdateState): string | undefined {
  const { waitingOn, deadline } = state
  if (!waitingOn || state.phase !== 'waiting') return undefined
  const { turns, subagents, routines } = waitingOn
  const time = deadline && new Date(deadline)
  const at =
    time && Number.isFinite(time.valueOf())
      ? time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : undefined
  return `Waiting for ${turns} ${turns === 1 ? 'turn' : 'turns'}, ${subagents} ${subagents === 1 ? 'sub-agent' : 'sub-agents'} and ${routines} ${routines === 1 ? 'routine' : 'routines'}. Nothing is interrupted.${at ? ` It gives up at ${at} and changes nothing.` : ''}`
}

/** Finishes that explain nothing once an offer is shown. */
const QUIET = new Set(['updated', 'current', 'cancelled', undefined])

/**
 * What the Software row says, one line each. A failure or rollback keeps its
 * explanation above a later offer, so opening Settings never loses it.
 */
export function softwareUpdateLines(state: MachineUpdateState): string[] {
  const waiting = waitingLine(state)
  if (waiting) return [waiting]
  const { run } = state
  if (state.phase === 'available' && run?.settled)
    return QUIET.has(run.finish)
      ? [offerLine(state)]
      : [updateLine(state), offerLine(state)].filter((line): line is string => !!line)
  const line = updateLine(state)
  return line ? [line] : []
}
