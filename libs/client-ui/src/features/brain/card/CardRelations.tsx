import {
  brainLinkSentence,
  type BrainConnection,
  type BrainEntityView,
  type BrainLink,
} from '@shared/brain'
import { TooltipButton } from '@/components/Tooltip'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { formatCount } from '@/lib/format'
import type { MapStep } from '../map/SentenceMap'

const STATED_BY: Record<BrainLink['statedBy'], string> = {
  reader: '',
  agent: 'Brain Agent',
  owner: 'you',
}

/** A connection of the card's entity as a sentence, subject to object. */
export function connectionSentence(view: BrainEntityView, connection: BrainConnection): string {
  const { link, entity } = connection
  const label = (id: string): string => (id === view.entity.id ? view.entity.label : entity.label)
  return brainLinkSentence(link, label(link.subjectId), label(link.objectId))
}

/** "Now" (relationships on the map) and "Before" (ended ones with their dates). */
export function CardRelations({
  view,
  onStep,
}: {
  view: BrainEntityView
  onStep: (step: MapStep) => void
}): React.JSX.Element {
  const now = view.groups.flatMap((group) => group.items)
  const more = view.groups.reduce((sum, group) => sum + group.total - group.items.length, 0)
  return (
    <>
      <section aria-label="Now" className="space-y-1">
        <SectionLabel>Now</SectionLabel>
        {now.length ? (
          <RelationList view={view} items={now} onStep={onStep} />
        ) : (
          <p className="text-text-tertiary text-sm">No relationship stated yet.</p>
        )}
        {more > 0 && <p className="text-text-tertiary text-sm">+{more} more on the map</p>}
      </section>
      {view.ended.length > 0 && (
        <section aria-label="Before" className="space-y-1">
          <SectionLabel>Before</SectionLabel>
          <RelationList view={view} items={view.ended} onStep={onStep} ended />
        </section>
      )}
    </>
  )
}

function RelationList({
  view,
  items,
  onStep,
  ended = false,
}: {
  view: BrainEntityView
  items: BrainConnection[]
  onStep: (step: MapStep) => void
  ended?: boolean
}): React.JSX.Element {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const sentence = connectionSentence(view, item)
        const by = STATED_BY[item.link.statedBy]
        return (
          <li key={item.link.id}>
            <TooltipButton
              aria-label={sentence}
              tooltip={`Walk to ${item.entity.label}`}
              className={ended ? 'brain-relation brain-relation--ended' : 'brain-relation'}
              onClick={() =>
                onStep({ to: { id: item.entity.id, label: item.entity.label }, link: item.link })
              }
            >
              <span className="min-w-0 flex-1">{sentence}</span>
              <span className="text-text-tertiary shrink-0 text-xs">
                {[by && `by ${by}`, formatCount(item.supports, 'memory', 'memories')]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </TooltipButton>
          </li>
        )
      })}
    </ul>
  )
}

/** People and things named with it that no relationship explains yet. */
export function CardTogether({
  view,
  onStep,
}: {
  view: BrainEntityView
  onStep: (step: MapStep) => void
}): React.JSX.Element | null {
  const count = view.together.length + view.togetherMore
  if (!count) return null
  return (
    <section aria-label="Together" className="space-y-1">
      <p className="text-text-secondary text-sm">+{count} appear together, not explained yet</p>
      <div className="flex flex-wrap gap-1">
        {view.together.map(({ entity, shared }) => (
          <TooltipButton
            key={entity.id}
            tooltip={`Named together in ${formatCount(shared, 'memory', 'memories')}`}
            className="bg-chip hover:text-text text-text-secondary rounded-md px-1.5 py-0.5 text-sm"
            onClick={() => onStep({ to: { id: entity.id, label: entity.label }, link: null })}
          >
            {entity.label} <span className="opacity-70">{shared}</span>
          </TooltipButton>
        ))}
      </div>
    </section>
  )
}
