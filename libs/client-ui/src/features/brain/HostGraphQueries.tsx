import { useState } from 'react'
import { BRAIN_ASK_MAX, BRAIN_TELL_MAX } from '@shared/brain'
import type { HostBrainMap } from '@shared/host-brain'
import { Button } from '@/components/form'
import { useBrainRequest, useHostBrainOffers, type ReadyBrainSurface } from './useHostBrain'
import type { MapStep } from './map/SentenceMap'

export function HostGraphSearch({
  brain,
  step,
  openMemory,
}: {
  brain: ReadyBrainSurface
  step: (step: MapStep) => void
  openMemory: (id: string) => void
}) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const { data, error, retry } = useBrainRequest<'brain:find'>(
    brain,
    query ? { method: 'brain:find', args: [query, 12] } : null,
  )
  return (
    <section aria-label="Search Brain">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setQuery(input.trim())
        }}
      >
        <input
          aria-label="Find in Brain"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={BRAIN_ASK_MAX}
        />{' '}
        <Button type="submit">Search</Button>
      </form>
      {error && (
        <p role="status">
          Brain search was refused. <Button onClick={retry}>Retry</Button>
        </p>
      )}
      {data && (
        <ul>
          {data.entities.map(({ id, label }) => (
            <li key={id}>
              <Button onClick={() => step({ to: { id, label }, link: null })}>{label}</Button>
            </li>
          ))}
          {data.memories.map(({ id, summary, entityIds }) => {
            const entity = data.referenced.find((item) => item.id === entityIds[0])
            return (
              <li key={id}>
                {brain.access.includes('evidence') ? (
                  <Button onClick={() => openMemory(id)}>{summary}</Button>
                ) : entity ? (
                  <Button onClick={() => step({ to: entity, link: null })}>{summary}</Button>
                ) : (
                  summary
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function HostGraphAsk({
  brain,
  onTell,
  onAnswer,
  openMemory,
}: {
  brain: ReadyBrainSurface
  onTell: () => void
  openMemory: (id: string) => void
  onAnswer: (recall: HostBrainMap['brain:ask']['result']) => void
}) {
  const [draft, setDraft] = useState('')
  const canTell = useHostBrainOffers(brain.hostId, 'brain:tell')
  const [answer, setAnswer] = useState<HostBrainMap['brain:ask']['result']>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = async (method: 'ask' | 'tell') => {
    const text = draft.trim()
    if (busy || !text || (method === 'ask' && text.length > BRAIN_ASK_MAX)) return
    setError('')
    setBusy(true)
    try {
      if (method === 'tell') {
        await brain.invoke<'brain:tell'>({ method: 'brain:tell', args: [text] })
        onTell()
      } else {
        const found = await brain.invoke<'brain:ask'>({ method: 'brain:ask', args: [text] })
        onAnswer(found)
        setAnswer(found)
      }
    } catch {
      setError(
        method === 'tell'
          ? 'The Host did not confirm your message. Check Brain Agent before trying again.'
          : 'The Host did not answer.',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Ask and Tell">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void send('ask')
        }}
      >
        <textarea
          aria-label="Ask Brain, or tell Brain Agent"
          maxLength={BRAIN_TELL_MAX}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />{' '}
        <Button
          type="submit"
          disabled={busy || !draft.trim() || draft.trim().length > BRAIN_ASK_MAX}
        >
          Ask
        </Button>{' '}
        {canTell && (
          <Button disabled={busy || !draft.trim()} onClick={() => void send('tell')}>
            Tell Brain Agent
          </Button>
        )}
      </form>
      {error && <p role="alert">{error}</p>}
      {answer && (
        <AnswerHits
          answer={answer}
          openMemory={brain.access.includes('evidence') ? openMemory : undefined}
        />
      )}
    </section>
  )
}

function AnswerHits({
  answer,
  openMemory,
}: {
  answer: HostBrainMap['brain:ask']['result']
  openMemory?: (id: string) => void
}) {
  return (
    <ul aria-label="Answer memories">
      {answer.hits.map(({ memory }) => (
        <li key={memory.id}>
          {openMemory ? (
            <Button onClick={() => openMemory(memory.id)}>{memory.summary}</Button>
          ) : (
            memory.summary
          )}
        </li>
      ))}
    </ul>
  )
}
