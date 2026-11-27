import { HostBrainEvidence, type HostEvidence } from './HostBrainEvidence'
import { HostBrainAccess, HostBrainApprovals } from './HostBrainAccess'
import { Activity, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { HostBrainStatus } from '@phosphor/shared/host-brain'
import { PageBody } from '@/components/PageBody'
import { PageShell } from '@/components/PageShell'
import { Button } from '@/components/form'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { useNavigation } from '@/navigation/Navigation'
import { usePlatform } from '@/platform/Platform'
import {
  HOST_BRAIN_HINT,
  useHostBrain,
  useHostBrainOffers,
  useHostBrainSelection,
  type ReadyBrainSurface,
} from './useHostBrain'
import { HostBrainAgent } from './HostBrainAgent'
import { HostBrainGraph } from './HostBrainGraph'
import { HostBrainReads } from './HostBrainReads'
import { useBrainTarget } from './brainNavigation'
import { pageKeyTarget } from './pageKeys'

type BrainView = 'conversation' | 'knowledge'
type ViewChoice = { selected: BrainView | undefined; select: (view: BrainView) => void }

export function HostBrainPage({ hostId }: { hostId?: string }): React.JSX.Element {
  const openSettings = useOpenSettings()
  return (
    <PageShell
      wide
      title={hostId ? `Brain · ${machineLabel(hostId)}` : 'Brain'}
      actions={
        hostId && (
          <Button size="sm" onClick={() => openSettings(hostId, 'brain')}>
            Settings
          </Button>
        )
      }
    >
      <PageBody className="host-brain-body">
        <HostPicker hostId={hostId} />
        <SelectedHostBrain key={hostId} hostId={hostId} />
      </PageBody>
    </PageShell>
  )
}

function SelectedHostBrain({ hostId }: { hostId?: string }) {
  // A view choice can survive reconnecting; all private content below remains connection-scoped.
  const [selected, select] = useState<BrainView>()
  const selection = useHostBrainSelection(hostId)
  return (
    <Fragment key={selection.key}>
      {hostId && selection.supported && selection.token && (
        <HostBrainAccess
          scope={{ hostId, connectionToken: selection.token }}
          rights={selection.access}
        />
      )}
      {hostId && selection.supported && selection.token && selection.access.length > 0 && (
        <HostBrainApprovals
          scope={{ hostId, connectionToken: selection.token }}
          rights={selection.access}
        />
      )}
      {hostId && selection.state === 'ready' && selection.token ? (
        <HostBrainContents
          hostId={hostId}
          selection={selection}
          connectionToken={selection.token}
          choice={{ selected, select }}
        />
      ) : (
        <p role="status" className="text-text-secondary">
          {HOST_BRAIN_HINT[selection.state === 'ready' ? 'unavailable' : selection.state]}
        </p>
      )}
    </Fragment>
  )
}

function HostPicker({ hostId }: { hostId?: string }) {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const machines = useMachinesStore((s) => s.machines)
  const { navigate } = useNavigation()
  const { localBrain, desktopBrainOwner } = usePlatform()
  const ids = [
    ...new Set([...machines.map((m) => m.id), ...Object.keys(hosts), ...(hostId ? [hostId] : [])]),
  ]
  return (
    <label className="flex flex-wrap items-center gap-2 text-base text-text-secondary">
      Host
      <select
        aria-label="Brain Host"
        className="min-w-0 max-w-full rounded-md border border-border bg-surface px-2 py-1 text-text"
        value={hostId ?? ''}
        onChange={(event) => {
          if (event.target.value)
            navigate({ to: 'page', page: 'brain', machine: event.target.value })
        }}
      >
        <option value="" disabled>
          Choose a Host
        </option>
        {localBrain && <option value="local">This Mac</option>}
        {ids
          .filter((id) => !desktopBrainOwner || !hosts[id]?.local)
          .map((id) => (
            <option key={id} value={id}>
              {machineLabel(id)}
            </option>
          ))}
      </select>
    </label>
  )
}

function embeddingState(status: HostBrainStatus): string {
  return status.embedding.phase === 'ready'
    ? 'Ready'
    : ['downloading', 'verifying', 'testing'].includes(status.embedding.phase)
      ? 'Preparing Brain…'
      : 'Brain is not ready to read lanes.'
}

function HostBrainContents({
  hostId,
  selection,
  connectionToken,
  choice,
}: {
  hostId: string
  selection: ReturnType<typeof useHostBrainSelection>
  connectionToken: string
  choice: ViewChoice
}) {
  const brain = useHostBrain(hostId, connectionToken, selection.access)
  const status = brain.status
  if (!status)
    return (
      <p role="status">
        {brain.error || 'Loading Brain…'}{' '}
        {brain.error && <Button onClick={() => void brain.refresh()}>Retry</Button>}
      </p>
    )
  if (!status.supported) return <p role="status">Brain cannot run on this Host.</p>
  if (!status.prefs.enabled)
    return <p role="status">Brain is off on this Host. Turn it on in Settings.</p>
  return <HostBrainEnabled key={status.generation} brain={{ ...brain, status }} choice={choice} />
}

function HostBrainEnabled({ brain, choice }: { brain: ReadyBrainSurface; choice: ViewChoice }) {
  const { selected, select } = choice
  const canReadConversation = useHostBrainOffers(brain.hostId, 'brain:laneShow')
  const view = selected ?? (canReadConversation ? 'conversation' : 'knowledge')
  const searchRef = useBrainSearchShortcut(select, view)
  return (
    <>
      <div role="group" aria-label="Brain views" className="flex flex-wrap gap-2">
        {(['conversation', 'knowledge'] as const).map((id) => (
          <Button
            key={id}
            size="sm"
            aria-pressed={view === id}
            className="aria-pressed:bg-sidebar-active aria-pressed:border-border-strong"
            onClick={() => select(id)}
          >
            {id === 'conversation' ? 'Conversation' : 'Knowledge'}
          </Button>
        ))}
      </div>
      {/* Preserve the current Host’s loaded pages and draft without polling in Knowledge. */}
      {canReadConversation && (
        <Activity mode={view === 'conversation' ? 'visible' : 'hidden'}>
          <HostBrainAgent brain={brain} />
        </Activity>
      )}
      {view === 'conversation' && !canReadConversation && (
        <p role="status" className="text-text-secondary">
          Conversation requires all Brain permissions and permission to control lanes on this Host.
        </p>
      )}
      {view === 'knowledge' && <HostBrainKnowledge brain={brain} searchRef={searchRef} />}
    </>
  )
}

function useBrainSearchShortcut(select: (view: BrainView) => void, view: BrainView) {
  const target = useBrainTarget()
  const search = useRef<HTMLInputElement>(null)
  const pendingFocus = useRef(false)
  const openSearch = useCallback(() => {
    select('knowledge')
    if (search.current) search.current.focus()
    else pendingFocus.current = true
  }, [select])
  useEffect(() => {
    if (target?.value.search) openSearch()
  }, [target, openSearch])
  useEffect(() => {
    if (view !== 'knowledge' || !pendingFocus.current) return
    pendingFocus.current = false
    search.current?.focus()
  }, [view])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pageKeyTarget(event, '/')) return
      event.preventDefault()
      openSearch()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [openSearch])
  return search
}

function HostBrainKnowledge({
  brain,
  searchRef,
}: {
  brain: ReadyBrainSurface
  searchRef: React.Ref<HTMLInputElement>
}) {
  const [evidence, setEvidence] = useState<HostEvidence | null>(null)
  return (
    <section className="space-y-3" aria-label="Knowledge">
      <p className="text-text-secondary text-base">
        {embeddingState(brain.status)} · {brain.status.counts.memories} memories ·{' '}
        {brain.status.counts.entities} people and things
      </p>
      <HostBrainGraph
        brain={brain}
        searchRef={searchRef}
        openMemory={(id) => setEvidence({ kind: 'memory', id })}
      />
      <HostBrainReads brain={brain} openRead={(id) => setEvidence({ kind: 'read', id })} />
      {evidence && (
        <HostBrainEvidence
          brain={brain}
          target={evidence}
          select={setEvidence}
          close={() => setEvidence(null)}
        />
      )}
    </section>
  )
}
