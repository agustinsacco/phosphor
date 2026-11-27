import { useState } from 'react'
import { BRAIN_ENTITY_KINDS, type BrainEntityKind } from '@shared/brain'
import { Button } from '@/components/form'
import { useBrainRequest, type ReadyBrainSurface } from './useHostBrain'

export function SplitChoice({
  brain,
  entityId,
  disabled,
  apply,
}: {
  brain: ReadyBrainSurface
  entityId: string
  disabled: boolean
  apply: (ids: string[], label: string, kind: BrainEntityKind) => void
}) {
  const [cursor, setCursor] = useState<string | null>(null)
  const [ids, setIds] = useState<string[]>([])
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<BrainEntityKind>('person')
  const page = useBrainRequest<'brain:entityMemories'>(brain, {
    method: 'brain:entityMemories',
    args: [entityId, {}, cursor],
  })
  return (
    <>
      <label>
        New name <input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
      </label>{' '}
      <select
        aria-label="New record kind"
        value={kind}
        onChange={(e) => {
          const next = BRAIN_ENTITY_KINDS.find((item) => item === e.target.value)
          if (next) setKind(next)
        }}
      >
        {BRAIN_ENTITY_KINDS.map((choice) => (
          <option key={choice}>{choice}</option>
        ))}
      </select>
      {page.error && (
        <p role="status">
          Memories unavailable. <Button onClick={page.retry}>Retry</Button>
        </p>
      )}
      {page.data?.memories.map(({ id, summary }) => (
        <label className="block" key={id}>
          <input
            type="checkbox"
            checked={ids.includes(id)}
            disabled={disabled || (ids.length >= 200 && !ids.includes(id))}
            onChange={(e) =>
              setIds(e.target.checked ? [...ids, id] : ids.filter((selected) => selected !== id))
            }
          />{' '}
          {summary}
        </label>
      ))}
      {cursor && <Button onClick={() => setCursor(null)}>First page</Button>}{' '}
      {page.data?.next && <Button onClick={() => setCursor(page.data!.next)}>More memories</Button>}
      <p>{ids.length} selected</p>
      <Button
        disabled={disabled || !label.trim() || !ids.length}
        onClick={() => apply(ids, label.trim(), kind)}
      >
        Move memories to new record
      </Button>
    </>
  )
}
