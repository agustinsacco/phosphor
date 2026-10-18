import {
  SNAPSHOT_COMMAND,
  SNAPSHOT_WIDGET,
  SNAPSHOT_PREFIX,
  snapshotContent,
  type InspectionSnapshot,
} from '@phosphor/pi-extensions/subagent-snapshot'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useArtifactsStore } from '@/stores/artifacts'
import { requireSubagentCommand } from './subagentCommands'

/** Save exactly the preview the reader chose, not a subsequently polled result. */
export async function saveSubagentSnapshot(
  sessionId: string,
  snapshot: InspectionSnapshot,
  signal: AbortSignal,
): Promise<string> {
  const expectedContent = snapshotContent(snapshot, snapshot.sourceSessionId)
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
          a.content !== expectedContent
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
