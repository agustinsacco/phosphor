import { useState } from 'react'
import { prKey } from '@shared/github-pr-refs'
import type { GhPrDetail, GhPrKey, GhPrRef, GhPrSummary } from '@shared/models'
import { appendToDraft, focusComposer } from '@/features/chat/composer/appendToDraft'
import { promptText } from '@/stores/prompt'
import type { ClosePill } from '../LaneHeaderPill'
import { setLanePrOverride, type LanePrOverride } from '../lanePrOverrides'
import type { LanePrs } from '../lanePrs'
import { prHandoff, type PrHandoff } from '../prHandoff'
import { parseTrackInput } from './trackInput'

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

export interface InspectorActions {
  /** Shown inline (`role="alert"`); a failure never closes the inspector. */
  error: string | null
  open: (url: string) => void
  copy: (url: string) => Promise<boolean>
  override: (action: LanePrOverride, ref: GhPrRef) => void
  trackOther: () => void
  handoff: (kind: PrHandoff) => void
}

/**
 * Everything the inspector does. Only `app:openExternal` and the clipboard
 * leave the app; Track and Hide go through the lane's own session file, and
 * hand-offs are drafts the person reads and sends.
 */
export function useInspectorActions({
  sessionId,
  prs,
  summary,
  detail,
  select,
  onClose,
  onPrompting,
}: {
  sessionId: string
  prs: LanePrs
  summary: GhPrSummary | undefined
  detail: GhPrDetail | undefined
  select: (key: GhPrKey) => void
  onClose: ClosePill
  onPrompting: (prompting: boolean) => void
}): InspectorActions {
  const [error, setError] = useState<string | null>(null)
  const override = (action: LanePrOverride, ref: GhPrRef): void => {
    setError(null)
    setLanePrOverride(sessionId, action, ref)
      .then(() => {
        if (action === 'pin') select(prKey(ref))
      })
      .catch((cause: unknown) => setError(message(cause, 'Could not update this lane.')))
  }
  return {
    error,
    open: (url) => {
      setError(null)
      window.phosphor
        .invoke('app:openExternal', url)
        .catch(() => setError('Could not open GitHub. Try again.'))
    },
    copy: (url) =>
      navigator.clipboard
        .writeText(url)
        .then(() => true)
        .catch(() => {
          setError('Could not copy the link.')
          return false
        }),
    override,
    trackOther: () => {
      setError(null)
      onPrompting(true)
      void promptText({
        title: 'Track a pull request',
        message: prs.home
          ? `Paste its URL, or a number like #123 in ${prs.home.owner}/${prs.home.repo}.`
          : 'Paste its URL.',
        placeholder: 'https://github.com/owner/repo/pull/123',
        submitLabel: 'Track',
      }).then((text) => {
        onPrompting(false)
        if (!text) return
        const parsed = parseTrackInput(text, prs.home)
        if ('error' in parsed) setError(parsed.error)
        else override('pin', parsed.ref)
      })
    },
    handoff: (kind) => {
      if (!summary) return
      appendToDraft(sessionId, prHandoff(kind, summary, detail))
      focusComposer()
      onClose(false)
    },
  }
}
