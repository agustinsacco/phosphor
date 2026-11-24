import { ipcErrorText } from '@shared/errors'
import { promptChoice } from '@/stores/prompt'
import { brainToast, useBrain } from './useBrain'
import { brainLaneTitle } from './laneTitle'

/**
 * Read again from the lane menu: find the lane's newest finished read, say what the new read
 * replaces and what stays, then read it again on confirmation.
 */
export async function readLaneAgain(sessionId: string): Promise<void> {
  try {
    const read = await window.phosphor.invoke('brain:laneRead', sessionId)
    if (!read) {
      brainToast('Brain has no finished read of this lane.', 'error')
      return
    }
    const kept = read.memories - read.replaceable
    const choice = await promptChoice({
      title: `Read “${brainLaneTitle(read.job.title)}” again?`,
      message:
        `Brain reads the whole lane again. The ${read.replaceable} unshared current memories stay until the new result is saved. Then they are replaced.` +
        (kept > 0 ? ` ${kept} shared current memories are kept.` : ''),
      choices: [{ value: 'read', label: 'Read again', primary: true }],
    })
    if (choice === 'read') await useBrain.getState().reread(read.job.id)
  } catch (cause) {
    brainToast(ipcErrorText(cause), 'error')
  }
}
