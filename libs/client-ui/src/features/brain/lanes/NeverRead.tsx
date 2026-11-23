import type { BrainPrefs } from '@shared/brain'
import { Button } from '@/components/form'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { formatCount } from '@/lib/format'
import { useBrain } from '../useBrain'
import { LaneRowButton } from './LaneList'

type NeverReadPrefs = BrainPrefs['neverRead']

/** "2 title patterns · 1 lane switched off": the row's one line. */
export function neverReadLine(never: NeverReadPrefs): string {
  if (!never.titles.length && !never.sessionIds.length) return 'Brain reads every lane'
  return [
    never.titles.length && formatCount(never.titles.length, 'title pattern'),
    never.sessionIds.length && `${formatCount(never.sessionIds.length, 'lane')} switched off`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The last group in Lanes: one row for the lanes Brain never reads. */
export function NeverReadRow({
  never,
  selected,
  onSelect,
}: {
  never: NeverReadPrefs
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const folder = useBrain((s) => s.status?.agent.folder)
  return (
    <section aria-label="Never read">
      <SectionLabel>Never read</SectionLabel>
      {folder && (
        <p className="text-text-tertiary px-2 py-1 text-sm">
          🧠 Brain Agent · Brain never reads its own lane
        </p>
      )}
      <LaneRowButton
        title="Lanes Brain never reads"
        line={neverReadLine(never)}
        selected={selected}
        onClick={onSelect}
      />
    </section>
  )
}

/** The never-read rule in words, and the way to change it. */
export function NeverReadDetail({ never }: { never: NeverReadPrefs }): React.JSX.Element {
  const openSettings = useOpenSettings()
  const switched = never.sessionIds.length
  return (
    <article aria-label="Never read detail" className="min-w-0 space-y-4 p-4">
      <header>
        <h2 className="text-xl font-semibold">Lanes Brain never reads</h2>
        <p className="text-text-tertiary text-sm">
          Brain does not read these lanes. Brain never reads its own lane.
        </p>
      </header>
      <section aria-label="Title patterns" className="space-y-1">
        <SectionLabel>Titles</SectionLabel>
        {never.titles.length ? (
          <p className="px-2 [overflow-wrap:anywhere]">
            A lane whose title contains{' '}
            {never.titles.map((title, index) => (
              <span key={title}>
                {index > 0 && (index === never.titles.length - 1 ? ' or ' : ', ')}
                <b className="font-medium">“{title}”</b>
              </span>
            ))}
            , in any case and not inside a longer word or number.
          </p>
        ) : (
          <p className="text-text-tertiary px-2">No title patterns.</p>
        )}
      </section>
      <section aria-label="Switched off" className="space-y-1">
        <SectionLabel>One by one</SectionLabel>
        <p className="px-2">
          {switched
            ? `${formatCount(switched, 'lane')} switched off one by one.`
            : 'No lane is switched off one by one.'}
        </p>
      </section>
      <Button onClick={() => openSettings('local', 'brain')}>Change in Settings</Button>
    </article>
  )
}
