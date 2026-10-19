import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { RemoteLaneRow } from '@/features/home/RemoteLaneRow'
import { useNavigation } from '@/navigation/Navigation'
import { artifactOnMachine } from '@/features/artifacts/globalArtifacts'
import { useEffect, useState } from 'react'
import { useRemoteLanesStore, openRemoteLane, REMOTE_NOT_READY } from '@/stores/remoteLanes'
import { openMachinePage } from '@/stores/machinePages'
import { TooltipButton } from '@/components/Tooltip'
import { Skeleton } from './MachineUi'

type Key = 'skills' | 'routines' | 'artifacts'
/** A count is loading until its read settles; a failed read is Unavailable, never zero. */
type Count = number | 'loading' | 'failed'
const LANES_SHOWN = 3

export function OnThisMachine({ hostId }: { hostId: string }): React.JSX.Element | null {
  const { navigate } = useNavigation()
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const generation = useRemoteLanesStore(() => machineReadGeneration(hostId))
  const [counts, setCounts] = useState<Partial<Record<Key, Count>>>({})
  useEffect(() => {
    let current = true
    const isCurrent = () => current && machineReadGeneration(hostId) === generation
    const host = useRemoteLanesStore.getState().hosts[hostId]
    if (host?.state !== 'ready') {
      setCounts({})
      return
    }
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
    const granted = requests.filter((item) => host.capabilities.includes(item.capability))
    setCounts(Object.fromEntries(granted.map((item) => [item.key, 'loading'])))
    async function refresh(): Promise<void> {
      for (const item of granted) {
        if (!isCurrent()) return
        let count: Count
        try {
          count = await item.read()
        } catch {
          count = 'failed'
        }
        if (isCurrent()) setCounts((counts) => ({ ...counts, [item.key]: count }))
      }
    }
    void refresh()
    return () => {
      current = false
    }
  }, [hostId, generation])
  if (!host) return null
  const ready = host.state === 'ready'
  const tiles = (
    [
      ['skills', 'Skills', 'skills.read'],
      ['routines', 'Routines', 'routines'],
      ['artifacts', 'Artifacts', 'artifacts.read'],
    ] as const
  ).filter(([, , capability]) => host.capabilities.includes(capability))
  return (
    <div className="space-y-4">
      {!ready && <p className="text-text-tertiary text-sm">{REMOTE_NOT_READY}</p>}
      {host.capabilities.includes('sessions.read') && (
        <div>
          <p className="text-text-secondary mb-2 text-sm">
            {host.lanes.length} {host.lanes.length === 1 ? 'lane' : 'lanes'}
            {ready ? '' : ' · last known'}
          </p>
          {host.lanes.length > 0 && (
            <fieldset className="machine-lane-preview" aria-label="Lane preview" disabled={!ready}>
              {host.lanes.slice(0, LANES_SHOWN).map((lane) => (
                <RemoteLaneRow
                  key={lane.laneId}
                  lane={lane}
                  hostId={hostId}
                  disabled={!ready}
                  onOpen={() => {
                    if (ready) void openRemoteLane(hostId, lane.laneId)
                  }}
                />
              ))}
              {host.lanes.length > LANES_SHOWN && (
                <TooltipButton
                  className="machine-view-lanes"
                  onClick={() => navigate({ to: 'lanes', machine: hostId })}
                >
                  View all {host.lanes.length} lanes →
                </TooltipButton>
              )}
            </fieldset>
          )}
        </div>
      )}
      {tiles.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {tiles.map(([key, label]) => {
            const count = counts[key] ?? (ready ? 'loading' : 'failed')
            return (
              <MachineResourceTile
                key={key}
                label={label}
                count={count}
                disabled={!ready}
                onOpen={() => openMachinePage(key, hostId)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function MachineResourceTile({
  label,
  count,
  disabled,
  onOpen,
}: {
  label: string
  count: Count
  disabled: boolean
  onOpen: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      tooltip={`Open ${label} on this machine`}
      disabled={disabled}
      onClick={onOpen}
      className="border-border hover:bg-bg-secondary rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50"
    >
      <span className="text-text-tertiary block font-mono text-xs uppercase tracking-wider">
        {label}
      </span>
      <span className="mt-1 block text-xl font-semibold tabular-nums">
        {count === 'loading' ? (
          <>
            <Skeleton className="mt-1.5 h-4 w-8" />
            <span className="sr-only">Loading</span>
          </>
        ) : count === 'failed' ? (
          <span className="text-text-tertiary text-base font-normal">Unavailable</span>
        ) : (
          count
        )}
      </span>
    </TooltipButton>
  )
}
