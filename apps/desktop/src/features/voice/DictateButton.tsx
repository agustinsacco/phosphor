import { useEffect } from 'react'
import clsx from 'clsx'
import { iconButtonClass } from '@/components/ComposerButtons'
import { MicIcon, Spinner } from '@/components/icons'
import { useComposerFormatting } from '@/features/chat/composer/ComposerField'
import { useVoiceReady, useVoiceStore } from '@/stores/voice'
import { insertDictation } from './insertDictation'
import { useDictation } from './useDictation'

const LABELS = {
  idle: 'Dictate',
  starting: 'Starting the microphone…',
  listening: 'Stop and insert what you said',
  transcribing: 'Transcribing…',
} as const

/**
 * The composer's microphone. Shown only while voice input is on and its
 * model is on disk (Settings → Voice). The text lands at the caret, through
 * the same edit path as the formatting keys, so Undo removes it.
 */
export function DictateButton({
  textareaRef,
  onChange,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  onChange: (value: string, caret: number) => void
}): React.JSX.Element | null {
  useEffect(() => useVoiceStore.getState().subscribe(), [])
  const ready = useVoiceReady()
  const { apply } = useComposerFormatting(textareaRef, onChange)
  const { state, toggle } = useDictation((text) => {
    const el = textareaRef.current
    if (el) apply(insertDictation(el.value, el.selectionStart, el.selectionEnd, text))
  })

  if (!ready && state === 'idle') return null
  const busy = state === 'starting' || state === 'transcribing'
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={state === 'listening'}
      aria-label={LABELS[state]}
      title={LABELS[state]}
      className={clsx(iconButtonClass, state === 'listening' && 'text-danger hover:text-danger')}
    >
      {busy ? (
        <Spinner className="text-text-secondary" />
      ) : (
        <span className="relative flex">
          <MicIcon size={15} />
          {state === 'listening' && (
            <span className="bg-danger absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full" />
          )}
        </span>
      )}
    </button>
  )
}
