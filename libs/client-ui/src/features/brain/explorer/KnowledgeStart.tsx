import { useCallback } from 'react'
import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { relativeTime } from '@/lib/time'
import { useBrainResource } from '../useBrainResource'
import { MEMORY_TYPE_WORDS } from '../memoryLabels'
import type { BrainVisit } from './trail'

/** Knowledge before a selection: what Brain learned last, so there is always a way in. */
export function KnowledgeStart({
  trail,
  onVisit,
}: {
  /** Back and forward, once there is a trail to walk. */
  trail: React.ReactNode
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:recent', 20), [])
  const { data, error, retry } = useBrainResource(load)
  return (
    <div className="brain-scroll px-4 py-3">
      {trail}
      <p className="text-text-secondary pb-3">
        Pick someone or something in the index, or open one of the newest memories.
      </p>
      <section aria-label="Recently learned">
        <SectionLabel>Recently learned</SectionLabel>
        {!data && (
          <p role="status" className="py-2 text-sm">
            {error || 'Loading…'}{' '}
            {error && (
              <Button size="xs" onClick={retry}>
                Retry
              </Button>
            )}
          </p>
        )}
        {data && !data.items.length && (
          <p className="text-text-tertiary py-2 text-sm">
            Nothing yet. Right-click a lane and choose Queue for knowledge extraction.
          </p>
        )}
        <ul>
          {data?.items.map((memory) => (
            <li key={memory.id} className="border-border border-b">
              <TooltipButton
                tooltip={false}
                className="brain-type hover:bg-bg-secondary w-full rounded-md px-1 py-2 text-left"
                onClick={() => onVisit({ kind: 'memory', id: memory.id, label: memory.summary })}
              >
                <span className="brain-type-label">{MEMORY_TYPE_WORDS[memory.type]}</span>
                <span className="min-w-0">
                  <span className="brain-clamp block">{memory.summary}</span>
                  <span className="text-text-tertiary block text-sm">
                    {memory.originTitle ?? 'Unknown lane'} · learned{' '}
                    {relativeTime(memory.learnedAt)}
                  </span>
                </span>
              </TooltipButton>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
