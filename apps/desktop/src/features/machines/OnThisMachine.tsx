import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { artifactOnMachine } from '@/features/artifacts/globalArtifacts'
import { useEffect, useState } from 'react'
import { useRemoteLanesStore, openRemoteLane, REMOTE_NOT_READY } from '@/stores/remoteLanes'
import { openMachinePage } from '@/stores/machinePages'
import { Button } from '@/components/form'

export function OnThisMachine({ hostId }: { hostId: string }): React.JSX.Element | null {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const generation = useRemoteLanesStore(() => machineReadGeneration(hostId))
  const [counts, setCounts] = useState<{ skills?: number; routines?: number; artifacts?: number }>(
    {},
  )
  useEffect(() => {
    let current = true
    const isCurrent = () => current && machineReadGeneration(hostId) === generation
    setCounts({})
    const host = useRemoteLanesStore.getState().hosts[hostId]
    if (host?.state !== 'ready') return
    async function refresh(): Promise<void> {
      if (!host) return
      const requests = [
        {
          capability: 'skills.read',
          key: 'skills',
          read: async () => (await window.phosphor.invoke('hosts:skills', hostId)).skills.length,
        },
        {
          capability: 'routines',
          key: 'routines',
          read: async () =>
            (await window.phosphor.invoke('routines:list', `host:${hostId}`)).routines.filter(
              (r) => !r.archived,
            ).length,
        },
        {
          capability: 'artifacts.read',
          key: 'artifacts',
          read: async () =>
            (await window.phosphor.invoke('artifacts:list', [])).filter((a) =>
              artifactOnMachine(a.key, hostId, useRemoteLanesStore.getState().hosts),
            ).length,
        },
      ] as const
      for (const item of requests) {
        if (!isCurrent()) return
        if (!host.capabilities.includes(item.capability)) continue
        try {
          const count = await item.read()
          if (isCurrent()) setCounts((counts) => ({ ...counts, [item.key]: count }))
        } catch {
          /* An unavailable count is not zero. */
        }
      }
    }
    void refresh()
    return () => {
      current = false
    }
  }, [hostId, generation])
  if (!host) return null
  const ready = host.state === 'ready'
  return (
    <section className="space-y-3" aria-label="On this machine">
      <h2 className="text-lg font-semibold">On this machine</h2>
      {!ready && <p>{REMOTE_NOT_READY}</p>}
      {host.capabilities.includes('sessions.read') && (
        <div>
          <p>
            {host.lanes.length} lanes{ready ? '' : ' · last known'}
          </p>
          {host.lanes.map((lane) => (
            <Button
              key={lane.laneId}
              size="xs"
              disabled={!ready}
              onClick={() => void openRemoteLane(hostId, lane.laneId)}
            >
              {lane.title || 'Untitled lane'}
            </Button>
          ))}
        </div>
      )}
      {host.capabilities.includes('skills.read') && (
        <Button disabled={!ready} onClick={() => openMachinePage('skills', hostId)}>
          Skills · {counts.skills ?? 'Unavailable'}
        </Button>
      )}
      {host.capabilities.includes('routines') && (
        <Button disabled={!ready} onClick={() => openMachinePage('routines', hostId)}>
          Routines · {counts.routines ?? 'Unavailable'}
        </Button>
      )}
      {host.capabilities.includes('artifacts.read') && (
        <Button disabled={!ready} onClick={() => openMachinePage('artifacts', hostId)}>
          Artifacts · {counts.artifacts ?? 'Unavailable'}
        </Button>
      )}
    </section>
  )
}
