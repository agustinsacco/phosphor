import { useState } from 'react'
import type { BrainEntityView } from '@shared/brain'
import { Button, Tag } from '@/components/form'
import { showMenuBelow } from '@/components/ContextMenu'
import { TooltipButton } from '@/components/Tooltip'
import { formatCount } from '@/lib/format'
import { relativeTime } from '@/lib/time'
import { ENTITY_WORDS } from '../memoryLabels'
import { EntityEditDialog, profileMenu, type EntityEdit } from '../explorer/EntityEdits'
import { BrainSearch } from '../explorer/BrainSearch'
import { MergeEntity } from '../explorer/MergeEntity'
import type { BrainVisit } from '../explorer/trail'
import type { MapOverlay } from '../map/useSentenceMap'
import { CardRoutes } from './CardRoutes'

type CardTool = 'route' | 'merge'
const TOOL_LABEL: Record<CardTool, string> = { route: 'How it connects to', merge: 'Merge into' }

/** "13 memories · 10 links · from 3 lanes · last learned 2 days ago". */
export function cardLine(view: BrainEntityView): string {
  return [
    formatCount(view.entity.memories, 'memory', 'memories'),
    formatCount(view.entity.connections, 'link'),
    `from ${formatCount(view.sources.length, 'lane')}`,
    view.lastLearnedAt !== null && `last learned ${relativeTime(view.lastLearnedAt)}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Name, kind, whether it is you, what it is, and the edits: merge, split, names, description. */
export function CardHeader({
  view,
  owner,
  saving,
  onOwner,
  onVisit,
  onWhole,
  onLight,
}: {
  view: BrainEntityView
  /** This entity is you. */
  owner: boolean
  saving: boolean
  onOwner: (entityId: string | null) => void
  onVisit: (visit: BrainVisit) => void
  onWhole: () => void
  onLight: (overlay: MapOverlay) => void
}): React.JSX.Element {
  const { entity } = view
  const [tool, setTool] = useState<CardTool | null>(null)
  const [target, setTarget] = useState<BrainVisit | null>(null)
  const [edit, setEdit] = useState<EntityEdit | null>(null)
  const menu = [
    ...profileMenu(view, setEdit, onWhole),
    ...(owner
      ? [{ label: 'This is not me', onClick: () => onOwner(null), separatorAbove: true }]
      : []),
  ]
  return (
    <header className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 text-xl font-semibold [overflow-wrap:anywhere]">{entity.label}</h2>
        <Tag>{ENTITY_WORDS[entity.kind]}</Tag>
        {owner ? (
          <span className="bg-accent-soft text-text rounded-md px-1.5 py-0.5 text-xs">
            This is you
          </span>
        ) : (
          entity.kind === 'person' && (
            <Button
              size="xs"
              disabled={saving}
              tooltip="The map starts from you"
              onClick={() => onOwner(entity.id)}
            >
              This is me
            </Button>
          )
        )}
        <span className="ml-auto flex flex-wrap gap-1.5">
          <Button
            size="xs"
            aria-pressed={tool === 'route'}
            tooltip="Find how it connects to another person or thing"
            onClick={() => setTool(tool === 'route' ? null : 'route')}
          >
            Connects to…
          </Button>
          <Button
            size="xs"
            aria-pressed={tool === 'merge'}
            disabled={saving}
            tooltip="Move everything Brain knows about it into another person or thing"
            onClick={() => setTool(tool === 'merge' ? null : 'merge')}
          >
            Merge into…
          </Button>
          <TooltipButton
            aria-label="More actions"
            tooltip="More actions"
            aria-haspopup="menu"
            className="brain-icon border-border border"
            onClick={(event) => showMenuBelow(event.currentTarget, menu, { title: entity.label })}
          >
            ⋯
          </TooltipButton>
        </span>
      </div>
      <p className={entity.description ? 'text-text-secondary' : 'text-text-tertiary'}>
        {entity.description || 'No description yet.'}
        {entity.aliases.length > 0 && (
          <span className="text-text-tertiary"> · also {entity.aliases.join(', ')}</span>
        )}
      </p>
      <p className="text-text-tertiary text-sm">{cardLine(view)}</p>
      {tool && (
        <section
          aria-label={TOOL_LABEL[tool]}
          className="border-border bg-bg-secondary space-y-2 rounded-md border p-2"
        >
          <p className="text-sm font-medium">
            {tool === 'route' ? `How ${entity.label} connects to…` : `Merge ${entity.label} into…`}
          </p>
          <BrainSearch entitiesOnly exclude={entity.id} onSelect={setTarget} />
          {target && tool === 'merge' && (
            <MergeEntity key={target.id} sourceId={entity.id} target={target} onVisit={onVisit} />
          )}
          {target && tool === 'route' && (
            <CardRoutes key={target.id} from={entity.id} to={target.id} onLight={onLight} />
          )}
        </section>
      )}
      {edit && <EntityEditDialog edit={edit} view={view} onClose={() => setEdit(null)} />}
    </header>
  )
}
