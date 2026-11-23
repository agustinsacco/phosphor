import { localRuntimeMode } from '../local-machine/mode'
import { sameMachine } from '../local-machine/same-machine'

export function serviceLanesRunning(): boolean {
  return (
    localRuntimeMode() === 'daemon' &&
    !!sameMachine()?.lanes.some((lane) => lane.activity !== 'stopped' && lane.activity !== 'failed')
  )
}

/** Override only the message about what quits; never stop the service to close Desktop. */
export function serviceQuitOptions(intent: 'quit' | 'update'): Partial<Electron.MessageBoxOptions> {
  if (localRuntimeMode() !== 'daemon') return {}
  return {
    detail:
      'Lanes on the Phosphor service keep running after Desktop quits. Desktop terminals close; save any unfinished terminal commands first.',
    buttons: ['Keep working', intent === 'quit' ? 'Quit Desktop' : 'Restart Desktop'],
  }
}
