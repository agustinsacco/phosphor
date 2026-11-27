import { HostBrainEvidence, type HostEvidence } from './HostBrainEvidence'
import { BRAIN_AGENT_RIGHTS_HINT, HostBrainAccess, HostBrainApprovals } from './HostBrainAccess'
import { useState } from 'react'
import type { HostBrainStatus } from '@phosphor/shared/host-brain'
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

export function HostBrainPage({ hostId }: { hostId?: string }): React.JSX.Element {
  const selection = useHostBrainSelection(hostId)
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
      <div key={selection.key} className="space-y-4 p-4">
        <HostPicker hostId={hostId} />
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
          />
        ) : (
          <p role="status">
            {HOST_BRAIN_HINT[selection.state === 'ready' ? 'unavailable' : selection.state]}
          </p>
        )}
      </div>
    </PageShell>
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
    <label className="flex items-center gap-2">
      Host
      <select
        aria-label="Brain Host"
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
}: {
  hostId: string
  selection: ReturnType<typeof useHostBrainSelection>
  connectionToken: string
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
  return <HostBrainEnabled key={status.generation} brain={{ ...brain, status }} />
}

function HostBrainEnabled({ brain }: { brain: ReadyBrainSurface }) {
  const [agent, setAgent] = useState(false)
  const [evidence, setEvidence] = useState<HostEvidence | null>(null)
  // Brain Agent's conversation shows evidence and drives changes: every Brain right, and lane control.
  const canChat = useHostBrainOffers(brain.hostId, 'brain:laneShow')
  return (
    <>
      <p role="status">
        {embeddingState(brain.status)} · {brain.status.counts.memories} memories ·{' '}
        {brain.status.counts.entities} people and things
      </p>
      <div className="flex flex-wrap gap-2" aria-label="Brain views">
        <Button aria-pressed={!agent} onClick={() => setAgent(false)}>
          Knowledge
        </Button>
        {canChat && (
          <Button aria-pressed={agent} onClick={() => setAgent(true)}>
            Brain Agent
          </Button>
        )}
      </div>
      {!canChat && brain.access.includes('control') && <p role="note">{BRAIN_AGENT_RIGHTS_HINT}</p>}
      {agent && canChat ? (
        <HostBrainAgent brain={brain} />
      ) : (
        <>
          <HostBrainGraph
            brain={brain}
            onTell={() => setAgent(true)}
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
        </>
      )}
    </>
  )
}
