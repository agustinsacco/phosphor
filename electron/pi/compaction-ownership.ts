import type { PiRpcClient } from './rpc-client'

/**
 * One compactor per session.
 *
 * On the Claude Code provider the CLI compacts its own session
 * (`--autocompact`, see `PI_CLAUDE_CLI_AUTOCOMPACT`) and carries the turn on
 * by itself. pi's compaction there rewrites only pi's record — the model's
 * context does not shrink — and it is not rare: pi fires when the reported
 * context passes `contextWindow - reserveTokens` (~183k on a 200k model),
 * a line a Claude session crosses long before a roomy CLI cap. One captured
 * multi-day session compacted pi's record nine times while the CLI compacted
 * four; each was a lossy rewrite that bought nothing.
 *
 * So pi's auto-compaction is switched off for sessions on that provider and
 * left at pi's default everywhere else. Applied at spawn (before the renderer
 * bootstraps from `get_state`, so the ⋮ menu shows the final state) and again
 * after a `set_model`, since the provider can change under a live session.
 * The ⋮ menu toggle still works: this decides the default, not a lock — a
 * user who wants pi's summary as well can have it, and the row says why.
 */
export function piAutoCompactionFor(provider: string | null | undefined): boolean {
  return provider !== 'pi-claude-cli'
}

export type CompactionOwner = 'pi' | 'cli' | 'unknown'

/**
 * Read the live provider and align pi's auto-compaction with it. Idempotent:
 * a session already in the right state sends nothing.
 */
export async function applyCompactionOwnership(
  client: Pick<PiRpcClient, 'request'>,
): Promise<CompactionOwner> {
  const state = await client.request({ type: 'get_state' })
  if (!state.success || !state.data) return 'unknown'
  const enabled = piAutoCompactionFor(state.data.model?.provider)
  if (state.data.autoCompactionEnabled !== enabled) {
    await client.request({ type: 'set_auto_compaction', enabled })
  }
  return enabled ? 'pi' : 'cli'
}
