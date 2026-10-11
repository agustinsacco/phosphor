import { validTargetId } from '@phosphor/pi-extensions/subagent-snapshot'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { requireSubagentCommand } from './subagentCommands'
import { isFleetActive, parseFleetWidget, SUBAGENT_ASYNC_WIDGET_KEY } from './subagentRuns'
import { selectedFleetNode, type SubagentTarget } from './subagentView'

export async function steerSubagent(
  sessionId: string,
  target: SubagentTarget,
  message: string,
): Promise<void> {
  if (
    !validTargetId(target.runId) ||
    (target.childId !== undefined && !validTargetId(target.childId))
  )
    throw new Error('Unsupported run identity.')
  const text = message.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 8000) throw new Error('Enter a message of at most 8,000 characters.')
  if (!target.childId && /^--child(?:\s|$)/.test(text))
    throw new Error('A root steering message cannot begin with --child.')
  await requireSubagentCommand(sessionId, 'subagents-steer')
  const fleet = parseFleetWidget(
    useExtensionUiStore.getState().widgets[sessionId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines,
  )
  const node = selectedFleetNode(fleet, target)
  if (!node || !isFleetActive(node.state))
    throw new Error('This exact target is no longer reported active. Refresh before steering.')
  const response = await window.phosphor.piCommand(sessionId, {
    type: 'prompt',
    message: `/subagents-steer ${target.runId}${target.childId ? ` --child ${target.childId}` : ''} ${text}`,
  })
  if (!response.success) throw new Error(response.error ?? 'Steering command failed.')
}
