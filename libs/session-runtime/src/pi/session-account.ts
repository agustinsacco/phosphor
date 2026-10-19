import type { PiRpcClient } from './rpc-client'
import type { RpcSessionState } from '@shared/rpc'

/** A read-only RPC preflight ran, but its provider cannot safely receive prompts. */
export class UnprovisionedClaudeStartupError extends Error {
  constructor(
    readonly state: Pick<RpcSessionState, 'model' | 'thinkingLevel' | 'sessionFile'>,
    readonly controlsVerified: boolean,
  ) {
    super('Cannot start Claude without a verified Claude account. Check Machine Settings.')
  }
}

/** Saved model metadata is only a prediction: pi can fall back at startup. */
export async function verifyStartupAccount(
  client: Pick<PiRpcClient, 'request'>,
  strict: boolean | undefined,
  accountId: string | undefined,
): Promise<void> {
  if (!strict || accountId) return
  const state = await client.request({ type: 'get_state' })
  if (!state.success || !state.data) throw new Error('Cannot verify the active pi account.')
  if (state.data.model?.provider !== 'pi-claude-cli') return
  let controlsVerified = false
  try {
    const commands = await client.request({ type: 'get_commands' })
    controlsVerified =
      commands.success &&
      Array.isArray(commands.data?.commands) &&
      commands.data.commands.some((command) => command.name === 'phosphor-context-budget')
  } catch {
    // Still fail closed. Diagnostic callers cannot report extension readiness.
  }
  const { model, thinkingLevel, sessionFile } = state.data
  throw new UnprovisionedClaudeStartupError({ model, thinkingLevel, sessionFile }, controlsVerified)
}
