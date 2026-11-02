import {
  SNAPSHOT_COMMAND,
  SNAPSHOT_WIDGET,
  SNAPSHOT_PREFIX,
  snapshotContent,
  snapshotReceiptMatches,
  type InspectionSnapshot,
} from '@phosphor/pi-extensions/subagent-snapshot'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useArtifactsStore } from '@/stores/artifacts'
import type { RpcSessionState } from '@phosphor/shared/rpc'
import { refreshRemoteArtifacts } from '@/features/artifacts/remoteArtifactRefresh'
import { requireSubagentCommand } from './subagentCommands'
import { onHostLane } from './subagentReads'

/**
 * The pane's save. It names pi's session when this window knows it; a Host lane's
 * window knows only its handle, so the Host's pi names itself. Then the artifact
 * index catches up, although no model turn ended.
 */
export async function saveFromPane(
  sessionId: string,
  meta: Pick<RpcSessionState, 'sessionId' | 'sessionFile'> | null | undefined,
  inspected: Omit<InspectionSnapshot, 'sourceSessionId'>,
  signal: AbortSignal,
): Promise<string> {
  if (!meta?.sessionId) throw new Error('Session identity is not available yet.')
  const onHost = onHostLane(sessionId)
  const snapshot = onHost ? inspected : { sourceSessionId: meta.sessionId, ...inspected }
  const id = await saveSubagentSnapshot(sessionId, snapshot, signal)
  if (onHost) void refreshRemoteArtifacts(sessionId)
  else if (meta.sessionFile)
    void window.phosphor.invoke('artifacts:forSession', meta.sessionFile).catch(() => {})
  return id
}

/** Save exactly the preview the reader chose, not a subsequently polled result. */
export async function saveSubagentSnapshot(
  sessionId: string,
  snapshot: InspectionSnapshot,
  signal: AbortSignal,
): Promise<string> {
  // Refuse an invalid snapshot before anything is sent.
  snapshotContent(snapshot, snapshot.sourceSessionId ?? '')
  await requireSubagentCommand(sessionId, SNAPSHOT_COMMAND)
  if (signal.aborted) throw new Error('Save cancelled.')
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, id?: string): void => {
      clearTimeout(timer)
      unsubscribe()
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(id!)
    }
    const abort = (): void => finish(new Error('Save cancelled.'))
    const timer = setTimeout(
      () => finish(new Error('Save receipt timed out. Check Artifacts before retrying.')),
      10_000,
    )
    const unsubscribe = useExtensionUiStore.subscribe((state) => {
      const line = state.widgets[sessionId]?.[SNAPSHOT_WIDGET]?.lines[0]
      if (!line?.startsWith(SNAPSHOT_PREFIX) || line.length > 700_000) return
      try {
        const reply = JSON.parse(line.slice(SNAPSHOT_PREFIX.length))
        if (reply.requestId !== requestId) return
        if (reply.error) throw new Error(String(reply.error))
        const a = reply.artifact
        if (
          !a ||
          !/^subagent-[a-z0-9-]{1,55}$/.test(a.id) ||
          a.type !== 'markdown' ||
          a.version !== 1 ||
          !snapshotReceiptMatches(snapshot, a.content)
        )
          throw new Error('Save receipt did not match the snapshot.')
        useArtifactsStore.getState().ingest(sessionId, 'artifact_create', a, { autoOpen: false })
        finish(undefined, a.id)
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Invalid save receipt.'))
      }
    })
    signal.addEventListener('abort', abort, { once: true })
    void window.phosphor
      .piCommand(sessionId, {
        type: 'prompt',
        message: `/${SNAPSHOT_COMMAND} ${requestId} ${encodeURIComponent(JSON.stringify(snapshot))}`,
      })
      .then((reply) => {
        if (!reply.success) finish(new Error(reply.error ?? 'Save command failed.'))
      })
      .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}
