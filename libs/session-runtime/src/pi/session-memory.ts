import type { RuntimeLog } from '../file-log'
import type { LiveSession } from './session-registry'
import type { SessionMemoryAugmentation } from './session-startup'

/** Install before the baseline so a concurrent native-session replacement invalidates it too. */
export async function attachSessionMemory(
  live: LiveSession,
  memory: SessionMemoryAugmentation,
  log: RuntimeLog,
): Promise<void> {
  const failed = async (error: unknown): Promise<void> => {
    delete live.memoryInput
    log('brain', 'Optional memory disabled', { sessionId: live.sessionId, error: String(error) })
    try {
      await memory.dispose()
    } catch (failure) {
      log('brain', 'Optional memory cleanup failed', { error: String(failure) })
    }
  }
  if (memory.beforeInput)
    live.memoryInput = {
      beforeInput: (command) => memory.beforeInput!(command),
      invalidate: () => memory.invalidateInput?.(),
      failed,
    }
  try {
    await memory.onCreated(live)
  } catch (error) {
    await failed(error)
  }
}
