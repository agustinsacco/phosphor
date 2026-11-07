import type { ContextFileKind } from '@shared/context-files'
import { useMcpServers, type McpServersState } from '@/features/connectors/useMcpServers'
import { useContextFilesPrefStore } from '@/stores/contextFilesPref'
import { useSessionsStore } from '@/stores/sessions'

/** The writes behind a lane's context sources: its rule toggles and its connector config. */
export interface LaneContextSource {
  mcp: McpServersState
  setRule: (kind: ContextFileKind, included: boolean) => Promise<void>
}

/**
 * This Mac's context-source writes for the lane (or the home composer without one); null where
 * the lane's machine has no context-files write: every Host, until it offers `lane.contextFiles`.
 */
export function useLaneContextSource(
  workspacePath: string,
  sessionId: string | undefined,
): LaneContextSource | null {
  const live = useSessionsStore((s) => (sessionId ? s.live[sessionId] : undefined))
  const writable = live?.target?.kind !== 'remote'
  const mcp = useMcpServers(writable ? (live?.workspacePath ?? workspacePath) : null)
  if (!writable) return null
  return {
    mcp,
    setRule: (kind, included) => useContextFilesPrefStore.getState().set(kind, included, sessionId),
  }
}
