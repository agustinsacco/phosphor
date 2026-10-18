import { requireSubagentCommand } from './subagentCommands'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { isFleetActive, parseFleetWidget, SUBAGENT_ASYNC_WIDGET_KEY } from './subagentRuns'

/** Exact current-session root only. The extension checks ownership again at execution time. */
export async function stopSubagent(sessionId: string, runId: string): Promise<void> {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}$/.test(runId))
    throw new Error('Unsupported run identity.')
  await requireSubagentCommand(sessionId, 'subagents-stop')
  const lines =
    useExtensionUiStore.getState().widgets[sessionId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines
  const run = parseFleetWidget(lines)?.runs.find((r) => r.id === runId)
  if (!run || !isFleetActive(run.state))
    throw new Error('This run is no longer reported active. Refresh before trying again.')
  const response = await window.phosphor.piCommand(sessionId, {
    type: 'prompt',
    message: `/subagents-stop ${runId}`,
  })
  if (!response.success) throw new Error(response.error ?? 'Stop command failed.')
}
