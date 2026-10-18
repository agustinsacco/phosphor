import type { AgentMessage } from '@phosphor/shared/rpc'
import {
  isLaneBranchName,
  parseHostFrame,
  type HostFrame,
  type LaneSummary,
} from '@phosphor/shared/host-protocol'
import { normalizeLabel } from '@phosphor/shared/control-api'
import type { LiveState } from './state'

export function invalidSummary(state: LiveState, laneId: string) {
  try {
    state.options.log('lane.summary_invalid', { laneId })
  } catch {
    /* No values in logs. */
  }
}
function valid(state: LiveState, frame: HostFrame, laneId: string): boolean {
  try {
    if (parseHostFrame(JSON.stringify(frame)).ok) return true
  } catch {
    /* Fail closed. */
  }
  invalidSummary(state, laneId)
  return false
}
const title = (value: string | null | undefined) =>
  value != null && normalizeLabel(value) === value ? value : null
const model = (value: LaneSummary['model'] | undefined) =>
  value &&
  value.provider.length >= 1 &&
  value.provider.length <= 200 &&
  value.id.length >= 1 &&
  value.id.length <= 200
    ? value
    : null
export function validSummary(state: LiveState, summary: LaneSummary) {
  return valid(
    state,
    {
      type: 'lanes-delta',
      id: 'check',
      cursor: { epoch: state.options.epoch, seq: 1 },
      upsert: [summary],
      remove: [],
    },
    summary.laneId,
  )
}
export function summaryFor(state: LiveState, laneId: string): LaneSummary | null {
  const stored = state.options.store.getLane(laneId)
  if (!stored || stored.removedAt !== null) return null
  const { sessionFile: _sessionFile, removedAt: _removedAt, ...summary } = stored
  const live = state.attached.get(laneId)
  const sessionState = live?.projection.view().state
  const candidate: LaneSummary = {
    ...summary,
    activity: live?.projection.activity() ?? summary.activity,
    title:
      title(sessionState?.sessionName) ??
      title(summary.title) ??
      live?.firstPrompt ??
      firstPromptTitle(live?.projection.view().messages),
    model: model(sessionState?.model) ?? model(summary.model),
    branch: isLaneBranchName(summary.branch) ? summary.branch : null,
  }
  return validSummary(state, candidate) ? candidate : (live?.last ?? null)
}
export function promptTitle(message: string): string | null {
  const line = message
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean)
    ?.replace(/\s+/g, ' ')
  if (!line) return null
  let prefix = ''
  for (const character of line) {
    if (prefix.length + character.length > 79) break
    prefix += character
  }
  const result = line.length <= 80 ? line : prefix.trimEnd() + '…'
  // The shared label contract also refuses control and invisible characters.
  return normalizeLabel(result)
}
function firstPromptTitle(messages: readonly AgentMessage[] | undefined) {
  const message = messages?.find((m) => m.role === 'user')
  if (!message || message.role !== 'user') return null
  return promptTitle(
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n'),
  )
}
