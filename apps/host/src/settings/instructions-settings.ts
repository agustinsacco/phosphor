import type { MachineSettings } from '@phosphor/shared/machine-settings'
import {
  GlobalInstructionsError,
  globalInstructionsPath,
  readGlobalInstructions,
  writeGlobalInstructions,
} from '@phosphor/session-runtime/pi/global-instructions'
import type { SettingsContext } from './context'
import { SettingsFailure, withSettingsFileLock } from './files'

/** As for every config file the Host edits: no links, owned, not world-writable. */
const POLICY = { followLinks: false } as const

/** The file's problem is the user's to fix, so its message reaches the client. */
function settingsFailure(error: unknown): unknown {
  return error instanceof GlobalInstructionsError
    ? new SettingsFailure('bad-request', error.message)
    : error
}

/** pi's global context file in the Host's agent directory, revisioned by its own bytes. */
export function readInstructionsSettings(
  state: SettingsContext,
): Pick<MachineSettings, 'revision' | 'instructions'> {
  try {
    const instructions = readGlobalInstructions(state.agentDir, POLICY)
    return { revision: instructions.revision, instructions }
  } catch (error) {
    throw settingsFailure(error)
  }
}

export async function writeInstructionsSettings(
  state: SettingsContext,
  content: string,
  revision: string,
  authorized: () => boolean,
): Promise<void> {
  await withSettingsFileLock(globalInstructionsPath(state.agentDir).path, async () => {
    try {
      writeGlobalInstructions(state.agentDir, content, revision, POLICY, () => {
        if (!authorized())
          throw new SettingsFailure('forbidden', 'Configuration access was revoked.')
        return true
      })
    } catch (error) {
      throw settingsFailure(error)
    }
  })
}
