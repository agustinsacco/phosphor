import { EXIT } from '../checks'
import { ControlFailure } from '../control/client'
import {
  commandStore,
  controlResult,
  prepareControl,
  type CommandResult,
  type ControlContext,
} from '../control/command'

export async function runLogout(context: ControlContext, local = false): Promise<CommandResult> {
  try {
    if (local) {
      await commandStore(context).remove()
      return {
        exitCode: EXIT.ok,
        message: 'Forgot this machine locally. It stays listed until removed in Phosphor.',
      }
    }
    const { loaded, store, client } = await prepareControl(context)
    if (!loaded) return { exitCode: EXIT.ok, message: 'This machine is not signed in.' }
    let removed = false
    try {
      await client.revoke(loaded.identity.hostId, loaded.key)
    } catch (error) {
      if (!(error instanceof ControlFailure) || error.code !== 'gone') throw error
      removed = true
    }
    await store.remove()
    return {
      exitCode: EXIT.ok,
      message: removed
        ? 'This machine was already removed from the account.'
        : 'This machine is signed out.',
    }
  } catch (error) {
    const result = controlResult(error, context.signal)
    if (result.exitCode === EXIT.tempfail)
      result.message +=
        ' Run phosphor logout --local to forget this machine locally; it stays listed until removed in Phosphor.'
    return result
  }
}
