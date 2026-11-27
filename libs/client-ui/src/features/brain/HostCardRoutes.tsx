import { useState } from 'react'
import { BRAIN_ASK_MAX } from '@shared/brain'
import { Button } from '@/components/form'
import { RouteChoices } from './card/CardRoutes'
import type { MapOverlay } from './map/useSentenceMap'
import { useBrainRequest, type ReadyBrainSurface } from './useHostBrain'

export function HostCardRoutes({
  brain,
  from,
  onLight,
}: {
  brain: ReadyBrainSurface
  from: string
  onLight: (overlay: MapOverlay) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="xs" aria-expanded={open} onClick={() => setOpen(!open)}>
        Connects to…
      </Button>
      {open && <RouteSearch brain={brain} from={from} onLight={onLight} />}
    </>
  )
}

function RouteSearch({ brain, from, onLight }: Parameters<typeof HostCardRoutes>[0]) {
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  const search = useBrainRequest<'brain:find'>(
    brain,
    query.trim() && !target ? { method: 'brain:find', args: [query.trim(), 12] } : null,
  )
  const path = useBrainRequest<'brain:path'>(
    brain,
    target ? { method: 'brain:path', args: [from, target] } : null,
  )
  return (
    <section aria-label="Connects to" className="space-y-2">
      <input
        type="search"
        aria-label="Find route target"
        maxLength={BRAIN_ASK_MAX}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setTarget(null)
        }}
      />
      {search.error && <Button onClick={search.retry}>Retry search</Button>}
      {search.data?.entities
        .filter(({ id }) => id !== from)
        .map(({ id, label }) => (
          <Button
            key={id}
            onClick={() => {
              setTarget(id)
              setQuery(label)
            }}
          >
            {label}
          </Button>
        ))}
      {target && !path.data && (
        <p role="status">
          {path.error ? (
            <>
              Routes unavailable. <Button onClick={path.retry}>Retry</Button>
            </>
          ) : (
            'Finding how they connect…'
          )}
        </p>
      )}
      {path.data && <RouteChoices key={target} data={path.data} onLight={onLight} />}
    </section>
  )
}
