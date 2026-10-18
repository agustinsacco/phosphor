import type { PiRpcClient } from './rpc-client'

/** Saved model metadata is only a prediction: pi can fall back at startup. */
export async function verifyStartupAccount(
  client: Pick<PiRpcClient, 'request'>,
  strict: boolean | undefined,
  accountId: string | undefined,
): Promise<void> {
  if (!strict || accountId) return
  const state = await client.request({ type: 'get_state' })
  if (!state.success || !state.data) throw new Error('Cannot verify the active pi account.')
  if (state.data.model?.provider === 'pi-claude-cli')
    throw new Error(
      'Cannot start Claude without a verified Claude account. Check Machine Settings.',
    )
}
