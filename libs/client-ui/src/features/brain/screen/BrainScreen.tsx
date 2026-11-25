import { useEffect, useRef } from 'react'
import type { BrainStatus } from '@shared/brain'
import { Button } from '@/components/form'
import { useBrainTarget } from '../brainNavigation'
import { useBrainTargets } from '../useBrainTargets'
import { pageKeyTarget } from '../pageKeys'
import { useBrain } from '../useBrain'
import { BrainStatusBar } from '../BrainStatusBar'
import { SentenceMap } from '../map/SentenceMap'
import { WalkTrail } from '../map/WalkTrail'
import { FullMap } from '../explorer/FullMap'
import { BrainCard } from '../card/BrainCard'
import { WhatChanged } from '../changes/WhatChanged'
import { ReadRecordDialog } from '../changes/ReadRecordDialog'
import { AskAnswer } from './AskAnswer'
import { AskBar } from './AskBar'
import { SearchPalette } from './SearchPalette'
import { useBrainScreen, type BrainScreenState } from './useBrainScreen'

/** Plain keys on the page: `/` searches, `[` and `]` walk back and forward. */
function screenKeys(screen: BrainScreenState) {
  return (event: KeyboardEvent): void => {
    if (pageKeyTarget(event, '/')) screen.setSearching(true)
    else if (pageKeyTarget(event, '[')) screen.move(-1)
    else if (pageKeyTarget(event, ']')) screen.move(1)
    else return
    event.preventDefault()
  }
}

/**
 * Brain on one screen: the map and its walk with Ask below, the card (or an answer) beside
 * it with What changed, and what Brain is doing above both.
 */
export function BrainScreen({ status }: { status: BrainStatus }): React.JSX.Element {
  const screen = useBrainScreen(status)
  useEffect(() => {
    const listener = screenKeys(screen)
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [screen])
  const changes = useRef<HTMLElement>(null)
  useBrainTargets(useBrainTarget(), {
    openSearch: () => screen.setSearching(true),
    showChanges: () => {
      changes.current?.scrollIntoView({ block: 'nearest' })
      changes.current?.focus()
    },
    openRecord: (jobId) => screen.setRecord({ jobId, title: 'this read' }),
  })
  const setOwner = (id: string | null): void => {
    void useBrain.getState().setOwner(id)
  }
  return (
    <div className="brain-page">
      <BrainStatusBar />
      <div className="brain-screen">
        <section aria-label="Map" className="brain-map-pane">
          <WalkTrail
            walk={screen.walk}
            start={screen.centreLabel || null}
            onMove={screen.move}
            onJump={screen.jump}
          />
          <MapArea screen={screen} />
          <AskBar onAnswer={screen.setAnswer} />
        </section>
        <aside aria-label="Card" className="brain-card-pane">
          {screen.answer ? (
            <AskAnswer
              answer={screen.answer}
              onClose={() => screen.setAnswer(null)}
              onStep={screen.step}
            />
          ) : (
            <BrainCard
              view={screen.entity.data}
              error={screen.entity.error}
              retry={screen.entity.retry}
              ownerId={status.ownerId}
              onStep={screen.step}
              onVisit={screen.visit}
              onOwner={setOwner}
              onWhole={() => screen.setWhole(true)}
              onLight={screen.setLight}
              memoryActions={screen.memoryActions}
            />
          )}
          <WhatChanged
            ref={changes}
            onOpenRead={(jobId, title) => screen.setRecord({ jobId, title })}
          />
        </aside>
      </div>
      {screen.searching && (
        <SearchPalette onSelect={screen.visit} onClose={() => screen.setSearching(false)} />
      )}
      {screen.record && (
        <ReadRecordDialog
          jobId={screen.record.jobId}
          title={screen.record.title}
          onClose={() => screen.setRecord(null)}
          onMemory={(id, label) => {
            screen.setRecord(null)
            screen.visit({ kind: 'memory', id, label })
          }}
        />
      )}
    </div>
  )
}

function MapArea({ screen }: { screen: BrainScreenState }): React.JSX.Element {
  if (screen.whole)
    return (
      <FullMap
        entityId={screen.centreId}
        label={screen.centreLabel}
        path={screen.trail.length ? screen.trail : null}
        onOpen={(visit) => screen.visit(visit)}
        onClose={() => screen.setWhole(false)}
      />
    )
  if (!screen.centreId)
    return (
      <div role="status" className="flex-1 p-4 text-sm">
        {screen.overviewError ? (
          <>
            {screen.overviewError}{' '}
            <Button size="xs" onClick={screen.retryOverview}>
              Retry
            </Button>
          </>
        ) : screen.empty ? (
          <p className="text-text-secondary">
            Brain knows no one yet. It learns from your lanes as they finish.
          </p>
        ) : (
          'Loading map…'
        )}
      </div>
    )
  return (
    <SentenceMap
      centreId={screen.centreId}
      hops={screen.hops}
      onHops={screen.setHops}
      trail={screen.trail}
      overlay={screen.overlay}
      onStep={screen.step}
      onWhole={() => screen.setWhole(true)}
    />
  )
}
