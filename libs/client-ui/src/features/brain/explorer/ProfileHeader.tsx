import type { BrainEntityView } from '@shared/brain'
import { Button, Tag } from '@/components/form'
import { showMenuBelow, type ContextMenuItem } from '@/components/ContextMenu'
import { TooltipButton } from '@/components/Tooltip'
import { UnderlinedTabs } from '@/components/UnderlinedTabs'
import { formatCount } from '@/lib/format'
import { ENTITY_WORDS } from '../memoryLabels'
import type { BrainTrail as Trail } from './trail'

export type ProfileTab = 'memories' | 'connections' | 'lanes' | 'map'
export type ProfileTool = 'route' | 'merge'

/** "13 memories · 10 links · from 3 lanes". */
export function profileLine(view: BrainEntityView): string {
  return [
    formatCount(view.entity.memories, 'memory', 'memories'),
    formatCount(view.entity.connections, 'link'),
    `from ${formatCount(view.sources.length, 'lane')}`,
  ].join(' · ')
}

/** Back, forward and the last three steps; `[` and `]` do the same (see BrainKnowledge). */
export function ProfileTrail({
  trail,
  onMove,
  onJump,
}: {
  trail: Trail
  onMove: (delta: number) => void
  onJump: (index: number) => void
}): React.JSX.Element {
  const start = Math.max(0, trail.index - 2)
  return (
    <nav aria-label="Brain trail" className="text-text-secondary flex min-w-0 items-center gap-1 text-sm">
      <TooltipButton
        aria-label="Back"
        tooltip={{ label: 'Back', shortcut: ['['] }}
        className="brain-icon"
        disabled={trail.index < 0}
        onClick={() => onMove(-1)}
      >
        ←
      </TooltipButton>
      <TooltipButton
        aria-label="Forward"
        tooltip={{ label: 'Forward', shortcut: [']'] }}
        className="brain-icon"
        disabled={trail.index >= trail.items.length - 1}
        onClick={() => onMove(1)}
      >
        →
      </TooltipButton>
      <ol className="flex min-w-0 flex-wrap items-center gap-1">
        {trail.items.slice(start, trail.index + 1).map((visit, offset) => {
          const index = start + offset
          const label = visit.kind === 'memory' ? 'Memory' : visit.label
          return (
            <li key={index} className="flex min-w-0 items-center gap-1">
              {offset > 0 && <span aria-hidden="true">›</span>}
              {index === trail.index ? (
                <span aria-current="page" className="text-text truncate">
                  {label}
                </span>
              ) : (
                <TooltipButton
                  tooltip={`Back to ${label}`}
                  className="max-w-40 truncate hover:underline"
                  onClick={() => onJump(index)}
                >
                  {label}
                </TooltipButton>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** The part of a profile that stays put: name, actions, one line of counts, and the tabs. */
export function ProfileHeader({
  view,
  lastLearned,
  tab,
  tabs,
  onTab,
  tool,
  onTool,
  menu,
  saving,
}: {
  view: BrainEntityView
  /** "last learned 2 days ago", once Brain reports it. */
  lastLearned: string
  tab: ProfileTab
  tabs: readonly { value: ProfileTab; label: React.ReactNode }[]
  onTab: (tab: ProfileTab) => void
  tool: ProfileTool | null
  onTool: (tool: ProfileTool | null) => void
  menu: ContextMenuItem[]
  saving: boolean
}): React.JSX.Element {
  const { entity } = view
  return (
    <div className="space-y-1.5 px-4 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 text-xl font-semibold">{entity.label}</h2>
        <Tag>{ENTITY_WORDS[entity.kind]}</Tag>
        <span className="ml-auto flex flex-wrap gap-1.5">
          <Button
            size="xs"
            aria-pressed={tool === 'route'}
            tooltip="Find the shortest supported routes from here to someone or something else"
            onClick={() => onTool(tool === 'route' ? null : 'route')}
          >
            Find route…
          </Button>
          <Button
            size="xs"
            aria-pressed={tool === 'merge'}
            disabled={saving}
            tooltip="Move everything Brain knows about it into another person or thing"
            onClick={() => onTool(tool === 'merge' ? null : 'merge')}
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
      <p className="text-text-tertiary text-sm">
        {profileLine(view)}
        {lastLearned && ` · ${lastLearned}`}
      </p>
      <div className="-mx-4">
        <UnderlinedTabs id="brain-profile" label="Profile views" value={tab} onChange={onTab} tabs={tabs} />
      </div>
    </div>
  )
}
