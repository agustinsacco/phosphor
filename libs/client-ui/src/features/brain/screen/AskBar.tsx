import { useState } from 'react'
import { BRAIN_ASK_MAX, BRAIN_TELL_MAX } from '@shared/brain'
import { useBrain } from '../useBrain'
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
  const { text, setText, send, asking, telling, error, told, setError, canAsk, canTell } =
    useAskActions(onAnswer)
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
          maxLength={BRAIN_TELL_MAX}
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
          disabled={!canAsk}
          tooltip={{ label: 'Ask Brain', shortcut: ['Enter'] }}
        >
          Ask
        </Button>
        <Button
          size="sm"
          disabled={!canTell}
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
      {(asking || telling || error || told) && (
        <AskStatus asking={asking} telling={telling} error={error} told={told} onError={setError} />
      )}
    </form>
  )
}

/** Asking, sending, the error, or the sent instruction with a way to its lane. */
function AskStatus({
  asking,
  telling,
  error,
  told,
  onError,
}: {
  asking: boolean
  telling: boolean
  error: string
  told: { sessionPath: string | null } | null
  onError: (error: string) => void
}): React.JSX.Element {
  const active = useBrain((s) => ['queued', 'running'].includes(s.status?.agent.run?.state ?? ''))
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 pt-1 text-sm">
      {asking && <span className="text-text-tertiary">Asking Brain…</span>}
      {telling && (
        <span className="text-text-tertiary">
          {active ? 'Waiting for Brain Agent to finish…' : 'Sending to Brain Agent…'}
        </span>
      )}
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

function useAskActions(onAnswer: (answer: AskAnswerState) => void) {
  const [text, setText] = useState('')
  const [asking, setAsking] = useState(false)
  const [telling, setTelling] = useState(false)
  const [error, setError] = useState('')
  const [told, setTold] = useState<{ sessionPath: string | null } | null>(null)
  const canAsk = !!text.trim() && text.trim().length <= BRAIN_ASK_MAX && !asking
  const canTell = !!text.trim() && text.trim().length <= BRAIN_TELL_MAX && !telling
  const send = async (action: 'ask' | 'tell'): Promise<void> => {
    const value = text.trim()
    if (!(action === 'ask' ? canAsk : canTell)) return
    const setPending = action === 'ask' ? setAsking : setTelling
    setPending(true)
    setError('')
    setTold(null)
    try {
      if (action === 'ask')
        onAnswer({ question: value, recall: await window.phosphor.invoke('brain:ask', value) })
      else {
        setTold(await window.phosphor.invoke('brain:tell', value))
        setText((draft) => (draft === text ? '' : draft))
      }
    } catch (cause) {
      setError(ipcErrorText(cause))
    } finally {
      setPending(false)
    }
  }
  return { text, setText, send, asking, telling, error, told, setError, canAsk, canTell }
}
