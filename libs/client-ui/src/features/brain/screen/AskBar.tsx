import { useState } from 'react'
import { ipcErrorText } from '@shared/errors'
import { Button } from '@/components/form'
import { openBrainSource } from '../openBrainSource'
import type { AskAnswerState } from './useBrainScreen'

/**
 * Two explicit actions on one line: Enter asks Brain a question, ⌘Enter tells Brain Agent
 * something to do. The page never guesses which one a sentence meant.
 */
export function AskBar({
  onAnswer,
}: {
  onAnswer: (answer: AskAnswerState) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'ask' | 'tell' | null>(null)
  const [error, setError] = useState('')
  const [told, setTold] = useState<{ sessionPath: string | null } | null>(null)
  const send = async (action: 'ask' | 'tell'): Promise<void> => {
    const value = text.trim()
    if (!value || busy) return
    setBusy(action)
    setError('')
    setTold(null)
    try {
      if (action === 'ask')
        onAnswer({ question: value, recall: await window.phosphor.invoke('brain:ask', value) })
      else {
        setTold(await window.phosphor.invoke('brain:tell', value))
        setText('')
      }
    } catch (cause) {
      setError(ipcErrorText(cause))
    } finally {
      setBusy(null)
    }
  }
  return (
    <form
      aria-label="Ask Brain"
      className="brain-ask"
      onSubmit={(event) => {
        event.preventDefault()
        void send('ask')
      }}
    >
      <div className="flex items-end gap-2">
        <textarea
          aria-label="Ask Brain, or tell Brain Agent"
          rows={1}
          value={text}
          placeholder="Ask Brain a question, or tell Brain Agent what changed"
          className="brain-ask-input"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            void send(event.metaKey || event.ctrlKey ? 'tell' : 'ask')
          }}
        />
        <Button
          size="sm"
          type="submit"
          variant="primary"
          disabled={!text.trim() || !!busy}
          tooltip={{ label: 'Ask Brain', shortcut: ['Enter'] }}
        >
          Ask
        </Button>
        <Button
          size="sm"
          disabled={!text.trim() || !!busy}
          tooltip={{
            label: 'Send this to Brain Agent as an instruction',
            shortcut: ['⌘', 'Enter'],
          }}
          onClick={() => {
            void send('tell')
          }}
        >
          Tell Brain Agent
        </Button>
      </div>
      {(busy || error || told) && (
        <AskStatus busy={busy} error={error} told={told} onError={setError} />
      )}
    </form>
  )
}

/** Asking, sending, the error, or the sent instruction with a way to its lane. */
function AskStatus({
  busy,
  error,
  told,
  onError,
}: {
  busy: 'ask' | 'tell' | null
  error: string
  told: { sessionPath: string | null } | null
  onError: (error: string) => void
}): React.JSX.Element {
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 pt-1 text-sm">
      {busy === 'ask' && <span className="text-text-tertiary">Asking Brain…</span>}
      {busy === 'tell' && <span className="text-text-tertiary">Sending to Brain Agent…</span>}
      {error && <span className="text-danger">{error}</span>}
      {told && (
        <>
          <span className="text-text-secondary">Sent to Brain Agent.</span>
          <Button
            size="xs"
            disabled={!told.sessionPath}
            onClick={() => {
              if (told.sessionPath)
                openBrainSource(told.sessionPath).catch((cause: unknown) =>
                  onError(ipcErrorText(cause)),
                )
            }}
          >
            Open Brain lane
          </Button>
        </>
      )}
    </p>
  )
}
