import type { HostBrainMemoryDetail } from '@shared/host-brain'
import type { HostsSnapshot } from '@shared/ipc'
import { useNavigation } from '@/navigation/Navigation'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useState } from 'react'
import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { promptChoice } from '@/stores/prompt'
import { ExtractionOutcomes } from './BrainExtraction'
import { MemoryQuotes } from './MemoryQuotes'
import { useBrainRequest, type ReadyBrainSurface } from './useHostBrain'

export type HostEvidence = { kind: 'read' | 'memory'; id: string }

export function HostBrainEvidence({
  brain,
  target,
  select,
  close,
}: {
  brain: ReadyBrainSurface
  target: HostEvidence
  select: (target: HostEvidence) => void
  close: () => void
}) {
  if (!brain.access.includes('evidence')) return null
  const title = target.kind === 'read' ? 'How this lane was read' : 'Memory evidence'
  return (
    <ModalOverlay onClose={close}>
      <div role="dialog" aria-modal="true" aria-label={title}>
        <ModalPanel title={title} width={760} footer={<Button onClick={close}>Close</Button>}>
          <div className="max-h-[70vh] space-y-4 overflow-auto p-4 [overflow-wrap:anywhere]">
            {target.kind === 'read' ? (
              <ReadContent key={target.id} brain={brain} id={target.id} select={select} />
            ) : (
              <MemoryContent
                key={target.id}
                brain={brain}
                id={target.id}
                select={select}
                close={close}
              />
            )}
          </div>
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}

function ReadContent({
  brain,
  id,
  select,
}: {
  brain: ReadyBrainSurface
  id: string
  select: (target: HostEvidence) => void
}) {
  const [offset, setOffset] = useState(0)
  const record = useBrainRequest<'brain:extraction'>(brain, {
    method: 'brain:extraction',
    args: [id, offset],
  })
  const { data } = record
  if (!data) return <EvidenceLoading error={record.error} retry={record.retry} />
  const next = data.next
  return (
    <>
      <h3>{data.title}</h3>
      <ExtractionOutcomes
        key={offset}
        data={data}
        onMemory={(id) => select({ kind: 'memory', id })}
      />
      <details>
        <TooltipSummary>Source lane at extraction</TooltipSummary>
        <HostSource brain={brain} laneId={data.sourceLaneId} />
        {data.source.segments.map((segment) => (
          <article key={segment.entryId} className="border-border rounded-md border p-3">
            <SectionLabel>{segment.label}</SectionLabel>
            <p className="whitespace-pre-wrap">{segment.text}</p>
          </article>
        ))}
        {!data.source.segments.length && <p>No source excerpts available.</p>}
      </details>
      {offset > 0 && <Button onClick={() => setOffset(0)}>First page</Button>}{' '}
      {typeof next === 'number' && next > offset && (
        <Button onClick={() => setOffset(next)}>Next page</Button>
      )}
    </>
  )
}

function MemoryContent({
  brain,
  id,
  select,
  close,
}: {
  brain: ReadyBrainSurface
  id: string
  select: (target: HostEvidence) => void
  close: () => void
}) {
  const resource = useBrainRequest<'brain:memory'>(brain, { method: 'brain:memory', args: [id] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const { data } = resource
  if (!data) return <EvidenceLoading error={resource.error} retry={resource.retry} />
  const expected = { generation: brain.status.generation, revision: brain.status.revision }
  const forget = async () => {
    if (busy) return
    setBusy(true)
    setError(false)
    try {
      const choice = await promptChoice({
        title: 'Forget this memory?',
        message:
          'Permanently removes the memory and its evidence from this Host. This cannot be undone.',
        choices: [{ value: 'forget', label: 'Forget permanently' }],
      })
      if (choice !== 'forget') return
      await brain.invoke<'brain:forget'>({ method: 'brain:forget', args: [id], expected })
      await brain.refresh()
      close()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <h3>{data.memory.summary}</h3>
      {data.memory.origin && <p>Source: {data.memory.origin.title}</p>}
      <HostSource brain={brain} laneId={data.sourceLaneId} />
      <MemoryQuotes quotes={data.quotes} />
      {Object.entries(data.linkQuotes).map(([ref, quotes]) => (
        <MemoryQuotes key={ref} quotes={quotes} />
      ))}
      <MemoryHistory data={data} select={select} />
      {data.memory.jobId && (
        <Button onClick={() => select({ kind: 'read', id: data.memory.jobId! })}>
          How it was read
        </Button>
      )}{' '}
      {brain.access.includes('configure') && (
        <Button variant="danger" disabled={busy} onClick={() => void forget()}>
          Forget
        </Button>
      )}
      {error && <p role="alert">The Host did not confirm deletion. Refresh before trying again.</p>}
    </>
  )
}

function EvidenceLoading({ error, retry }: { error: boolean; retry: () => void }) {
  return (
    <p role="status">
      {error ? (
        <>
          Evidence unavailable. <Button onClick={retry}>Retry</Button>
        </>
      ) : (
        'Loading evidence…'
      )}
    </p>
  )
}

function MemoryHistory({
  data,
  select,
}: {
  data: HostBrainMemoryDetail
  select: (target: HostEvidence) => void
}) {
  return (
    <>
      {(data.history.length > 0 || data.related.length > 0) && (
        <section aria-label="Memory history">
          <h4>History</h4>
          <ul>
            {data.history.map((m) => (
              <li key={m.id}>
                Replaced:{' '}
                <Button onClick={() => select({ kind: 'memory', id: m.id })}>{m.summary}</Button>
              </li>
            ))}
            {data.related.map(({ kind, memory }) => (
              <li key={`${kind}:${memory.id}`}>
                {kind === 'conflicts'
                  ? 'Disagrees with'
                  : kind === 'resolves'
                    ? 'Answers'
                    : 'Supersedes'}
                :{' '}
                <Button onClick={() => select({ kind: 'memory', id: memory.id })}>
                  {memory.summary}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

function HostSource({ brain, laneId }: { brain: ReadyBrainSurface; laneId: string | null }) {
  const { navigate } = useNavigation()
  const canRead = useRemoteLanesStore((s) => canOpenSource(s.hosts, brain.hostId, laneId))
  return (
    <Button
      size="xs"
      disabled={!canRead}
      onClick={() => {
        if (
          laneId &&
          brain.capture()() &&
          canOpenSource(useRemoteLanesStore.getState().hosts, brain.hostId, laneId)
        )
          navigate({ to: 'lane', lane: { hostId: brain.hostId, laneId } })
      }}
    >
      Open source lane
    </Button>
  )
}

function canOpenSource(hosts: HostsSnapshot, hostId: string, laneId: string | null) {
  const host = hosts[hostId]
  return (
    host?.state === 'ready' &&
    host.capabilities.includes('sessions.read') &&
    host.lanes.some((lane) => lane.laneId === laneId)
  )
}
