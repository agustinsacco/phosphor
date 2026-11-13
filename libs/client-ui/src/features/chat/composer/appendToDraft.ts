import { useSessionsStore } from '@/stores/sessions'
import { composerDraftKey, useDraftsStore } from '@/stores/drafts'

/**
 * Add text to a lane's unsent message, space- or paragraph-separated, never
 * replacing what is there and never sending it. The Slack pill, the PR
 * inspector's hand-off buttons and PR notices all draft through this, so the
 * person reads and sends.
 */
export function appendToDraft(sessionId: string, text: string): void {
  const key = composerDraftKey(useSessionsStore.getState().live[sessionId], sessionId)
  const drafts = useDraftsStore.getState()
  drafts.setText(key, joinDraft(drafts.get(key).text, text))
}

/** Focus the composer after a draft lands. It is a sibling tree; F6 uses the same field. */
export function focusComposer(): void {
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLTextAreaElement>('[data-composer-input]')
      ?.focus({ preventScroll: true }),
  )
}

/** A one-line addition joins with a space; a paragraph starts after a blank line. */
export function joinDraft(current: string, text: string): string {
  if (text.includes('\n')) return current.trim() ? `${current.trimEnd()}\n\n${text}` : text
  return `${current}${current && !/\s$/.test(current) ? ' ' : ''}${text} `
}
