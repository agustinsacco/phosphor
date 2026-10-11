import { CONTEXT_FILE_LABELS, type ContextFileKind } from '@shared/context-files'
import { formatTokens } from '@/lib/format'
import type { ContextBreakdown } from './contextBreakdown'

export interface ContextFileToggleState {
  checked: boolean
  /** The lane found no file of this kind. Only knowable inside a lane. */
  missing: boolean
  title: string
}

/**
 * One checkbox's state and tooltip.
 *
 * `lane` is what the running lane reported (null on the home composer, or
 * before the lane has said anything); it wins over the preference, because a
 * lane started before the last toggle elsewhere keeps its own state.
 */
export function contextFileToggleState(
  kind: ContextFileKind,
  pref: boolean,
  lane: ContextBreakdown['contextFiles'],
  pending: boolean | undefined,
): ContextFileToggleState {
  const label = CONTEXT_FILE_LABELS[kind]
  const checked = pending ?? (lane ? !lane.off.includes(kind) : pref)
  if (!lane) {
    return {
      checked,
      missing: false,
      title: checked
        ? `New lanes send ${label} files to the model on every request. Uncheck to leave them out.`
        : `New lanes leave ${label} files out of the prompt. Check to send them again.`,
    }
  }
  const files = lane.files.filter((file) => file.kind === kind)
  if (files.length === 0) {
    return {
      checked,
      missing: true,
      title: `This lane has no ${label}. The setting still carries to new lanes.`,
    }
  }
  const tokens = files.reduce((sum, file) => sum + file.tokens, 0)
  const head = `${label} · ~${formatTokens(tokens)} tokens\n${files.map((file) => file.path).join('\n')}`
  return {
    checked,
    missing: false,
    title: checked
      ? `${head}\n\nSent on every request. Uncheck to leave it out from the next one; new lanes start the same way.`
      : `${head}\n\nLeft out of this lane. Check to send it again from the next request; new lanes start the same way.`,
  }
}
