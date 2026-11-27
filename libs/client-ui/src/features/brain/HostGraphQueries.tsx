import { useState } from 'react'
import { BRAIN_ASK_MAX } from '@shared/brain'
import type { HostBrainMap } from '@shared/host-brain'
import { Button, TextInput } from '@/components/form'
import { useBrainRequest, type ReadyBrainSurface } from './useHostBrain'
import type { MapStep } from './map/SentenceMap'

export function HostGraphSearch({
  brain,
  step,
  openMemory,
  searchRef,
}: {
  brain: ReadyBrainSurface
  searchRef: React.Ref<HTMLInputElement>
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
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setQuery(input.trim())
        }}
      >
        <TextInput
          ref={searchRef}
          type="search"
          placeholder="Find names or memories"
          className="min-w-0 flex-auto"
          aria-label="Find in Brain"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={BRAIN_ASK_MAX}
        />
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
  onAnswer,
  openMemory,
}: {
  brain: ReadyBrainSurface
  openMemory: (id: string) => void
  onAnswer: (recall: HostBrainMap['brain:ask']['result']) => void
}) {
  const [draft, setDraft] = useState('')
  const [answer, setAnswer] = useState<HostBrainMap['brain:ask']['result']>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const searchMemories = async () => {
    const text = draft.trim()
    if (busy || !text) return
    setError('')
    setBusy(true)
    try {
      const found = await brain.invoke<'brain:ask'>({ method: 'brain:ask', args: [text] })
      onAnswer(found)
      setAnswer(found)
    } catch {
      setError('The Host could not search memories.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Search memories by meaning" className="space-y-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void searchMemories()
        }}
      >
        <TextInput
          type="search"
          aria-label="Search memories by meaning"
          placeholder="Search memories by meaning"
          className="min-w-0 flex-auto"
          maxLength={BRAIN_ASK_MAX}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" disabled={busy || !draft.trim()}>
          Search memories
        </Button>
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
