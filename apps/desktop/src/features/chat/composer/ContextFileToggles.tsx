import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  CONTEXT_FILE_KINDS,
  CONTEXT_FILE_LABELS,
  type ContextFileKind,
} from '@shared/context-files'
import { ipcErrorText } from '@shared/errors'
import { useContextFilesPrefStore } from '@/stores/contextFilesPref'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { CONTEXT_BREAKDOWN_STATUS_KEY, parseContextBreakdown } from './contextBreakdown'
import { contextFileToggleState } from './contextFileToggle'

/**
 * CLAUDE.md / AGENTS.md checkboxes, in both composers.
 *
 * On the home composer they set what new lanes start with. Inside a lane they
 * change that lane from its next model request AND the starting state of new
 * lanes, so the last choice sticks. A lane's own state comes from what its pi
 * reports (`pi-ext/context-files.ts`), not from the preference, which may have
 * moved on since the lane started.
 */
export function ContextFileToggles({ sessionId }: { sessionId?: string }): React.JSX.Element {
  const prefs = useContextFilesPrefStore((s) => s.prefs)
  const statusText = useExtensionUiStore((s) =>
    sessionId ? s.statuses[sessionId]?.[CONTEXT_BREAKDOWN_STATUS_KEY] : undefined,
  )
  const lane = useMemo(() => parseContextBreakdown(statusText)?.contextFiles ?? null, [statusText])
  const [pending, setPending] = useState<Partial<Record<ContextFileKind, boolean>>>({})

  // The lane's next report settles any optimistic value.
  const reported = lane?.off.join(',')
  useEffect(() => setPending({}), [reported, sessionId])

  const toggle = (kind: ContextFileKind, included: boolean): void => {
    setPending((current) => ({ ...current, [kind]: included }))
    useContextFilesPrefStore
      .getState()
      .set(kind, included, sessionId)
      .catch((error: unknown) => {
        setPending((current) => ({ ...current, [kind]: undefined }))
        useExtensionUiStore
          .getState()
          .pushToast(
            `Couldn't change ${CONTEXT_FILE_LABELS[kind]}. ${ipcErrorText(error)}`,
            'error',
          )
      })
  }

  return (
    <div role="group" aria-label="Context files" className="flex items-center">
      {CONTEXT_FILE_KINDS.map((kind) => {
        const state = contextFileToggleState(kind, prefs[kind], lane, pending[kind])
        return (
          <label
            key={kind}
            title={state.title}
            className="hover:bg-bg-secondary flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors"
          >
            <input
              type="checkbox"
              checked={state.checked}
              onChange={(event) => toggle(kind, event.target.checked)}
              className="accent-[var(--px-accent)]"
            />
            <span
              className={clsx(
                'text-base',
                state.missing ? 'text-text-tertiary' : 'text-text-secondary',
                !state.checked && 'line-through',
              )}
            >
              {CONTEXT_FILE_LABELS[kind]}
            </span>
          </label>
        )
      })}
    </div>
  )
}
