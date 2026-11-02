import { useChatStore } from '@/stores/chat'
import { piCallInline } from '@/lib/rpc'
import { BASH_UNCONFIRMED } from '@shared/remote-host'

/**
 * Run a composer `!command` (or `!!command`, kept out of the model's context)
 * through pi's RPC `bash`, on This Mac or on the lane's Host, into one bash item.
 *
 * `piCallInline`, not `piCall`: a failed command belongs in its own item next
 * to the command, not on the session-wide error surface. A Host answers a
 * command within its deadline or says it cannot confirm it; a shell command can
 * outlast that, so an unconfirmed one is shown as such (not as a failure) and
 * keeps its Stop control.
 */
export async function runShellCommand(
  sessionId: string,
  command: string,
  excludeFromContext: boolean,
): Promise<void> {
  const chat = useChatStore.getState()
  const itemId = chat.addBashItem(sessionId, {
    command,
    output: '',
    exitCode: null,
    running: true,
    truncated: false,
    excludeFromContext,
  })
  const update = (patch: Parameters<typeof chat.updateBashItem>[2]): void =>
    useChatStore.getState().updateBashItem(sessionId, itemId, { running: false, ...patch })
  const response = await piCallInline(sessionId, { type: 'bash', command, excludeFromContext })
  if (response.ok && response.data) {
    const { output, exitCode, truncated, fullOutputPath } = response.data
    update({ output, exitCode, truncated, fullOutputPath })
  } else if (response.ok) {
    // A Host drops receipt data over its size cap: say so rather than spin forever.
    update({ output: 'The command ran, but its output was too large to return.' })
  } else if (response.error.endsWith(BASH_UNCONFIRMED)) {
    update({ output: response.error, unconfirmed: true })
  } else {
    update({ output: response.error, exitCode: -1 })
  }
}
