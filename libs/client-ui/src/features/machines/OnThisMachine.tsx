import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { RemoteLaneRow } from '@/features/sessions/RemoteLaneRow'
import { useNavigation } from '@/navigation/Navigation'
import { artifactOnMachine } from '@/features/artifacts/globalArtifacts'
import { useEffect, useState } from 'react'
import { useRemoteLanesStore, REMOTE_NOT_READY } from '@/stores/remoteLanes'
import { openMachinePage } from '@/stores/machinePages'
import { TooltipButton } from '@/components/Tooltip'
import { LocalLanePreviewRow, useLocalLanes } from './LocalLanePreview'
import { Skeleton } from './MachineUi'

type Key = 'skills' | 'routines' | 'artifacts'
/** A count is loading until its read settles; a failed read is Unavailable, never zero. */
type Count = number | 'loading' | 'failed'
const LANES_SHOWN = 3
const LABELS: Record<Key, string> = {
  skills: 'Skills',
  routines: 'Routines',
  artifacts: 'Artifacts',
}

/** What On this machine shows for This Mac or a Host. */
interface MachineResources {
  /** `'local'` or a Host id: where View all and the tiles go. */
  machine: string
  /** False while a Host is not connected: lanes are last known, links are off. */
  ready: boolean
  /** The lane count and up to three rows; null where lanes cannot be read. */
  lanes: { count: number; rows: React.ReactNode } | null
  /** The tiles this machine offers, and each count read so far. */
  tiles: Key[]
  counts: Partial<Record<Key, Count>>
}

/** Reads each count in turn while `isCurrent` holds; a failed read is `failed`. */
async function readCounts(
  reads: readonly { key: Key; read: () => Promise<number> }[],
  isCurrent: () => boolean,
  set: (key: Key, count: Count) => void,
): Promise<void> {
  for (const { key, read } of reads) {
    if (!isCurrent()) return
    let count: Count
    try {
      count = await read()
    } catch {
      count = 'failed'
    }
    if (isCurrent()) set(key, count)
  }
}

const HOST_READS = [
  {
    capability: 'skills.read',
    key: 'skills',
    read: async (hostId: string) =>
      (await window.phosphor.invoke('hosts:skills', hostId)).skills.length,
  },
  {
    capability: 'routines',
    key: 'routines',
    read: async (hostId: string) =>
      (await window.phosphor.invoke('routines:list', `host:${hostId}`)).routines.filter(
        (r) => !r.archived,
      ).length,
  },
  {
    capability: 'artifacts.read',
    key: 'artifacts',
    read: async (hostId: string) =>
      (await window.phosphor.invoke('artifacts:list', [])).filter((a) =>
        artifactOnMachine(a.key, hostId, useRemoteLanesStore.getState().hosts),
      ).length,
  },
] as const

function useHostResources(hostId: string): MachineResources | null {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const generation = useRemoteLanesStore(() => machineReadGeneration(hostId))
  const [counts, setCounts] = useState<Partial<Record<Key, Count>>>({})
  useEffect(() => {
    let current = true
    const host = useRemoteLanesStore.getState().hosts[hostId]
    if (host?.state !== 'ready') {
      setCounts({})
      return
    }
    const granted = HOST_READS.filter((item) => host.capabilities.includes(item.capability))
    setCounts(Object.fromEntries(granted.map((item) => [item.key, 'loading'])))
    void readCounts(
      granted.map((item) => ({ key: item.key, read: () => item.read(hostId) })),
      () => current && machineReadGeneration(hostId) === generation,
      (key, count) => setCounts((counts) => ({ ...counts, [key]: count })),
    )
    return () => {
      current = false
    }
  }, [hostId, generation])
  if (!host) return null
  const ready = host.state === 'ready'
  return {
    machine: hostId,
    ready,
    lanes: host.capabilities.includes('sessions.read')
      ? {
          count: host.lanes.length,
          rows: host.lanes
            .slice(0, LANES_SHOWN)
            .map((lane) => (
              <RemoteLaneRow key={lane.laneId} lane={lane} hostId={hostId} ready={ready} />
            )),
        }
      : null,
    tiles: HOST_READS.filter((item) => host.capabilities.includes(item.capability)).map(
      (item) => item.key,
    ),
    counts,
  }
}

const LOCAL_READS: readonly { key: Key; read: () => Promise<number> }[] = [
  { key: 'skills', read: async () => (await window.phosphor.invoke('skills:list')).skills.length },
  {
    key: 'routines',
    read: async () =>
      (await window.phosphor.invoke('routines:list', 'local')).routines.filter((r) => !r.archived)
        .length,
  },
  {
    key: 'artifacts',
    read: async () =>
      (await window.phosphor.invoke('artifacts:list', [])).filter((a) =>
        artifactOnMachine(a.key, 'local', {}),
      ).length,
  },
]

function useLocalResources(): MachineResources {
  const lanes = useLocalLanes()
  const [counts, setCounts] = useState<Partial<Record<Key, Count>>>(() =>
    Object.fromEntries(LOCAL_READS.map(({ key }) => [key, 'loading'])),
  )
  useEffect(() => {
    let current = true
    void readCounts(
      LOCAL_READS,
      () => current,
      (key, count) => setCounts((counts) => ({ ...counts, [key]: count })),
    )
    return () => {
      current = false
    }
  }, [])
  return {
    machine: 'local',
    ready: true,
    lanes: {
      count: lanes.length,
      rows: lanes
        .slice(0, LANES_SHOWN)
        .map((lane) => <LocalLanePreviewRow key={lane.key} lane={lane} />),
    },
    tiles: LOCAL_READS.map(({ key }) => key),
    counts,
  }
}

/** A machine's lanes, skills, routines and artifacts: This Mac's (`'local'`) or a Host's. */
export function OnThisMachine({ hostId }: { hostId: string }): React.JSX.Element | null {
  return hostId === 'local' ? <LocalResources /> : <HostResources hostId={hostId} />
}
function LocalResources(): React.JSX.Element {
  return <MachineResourcesCard resources={useLocalResources()} />
}
function HostResources({ hostId }: { hostId: string }): React.JSX.Element | null {
  const resources = useHostResources(hostId)
  return resources && <MachineResourcesCard resources={resources} />
}

function MachineResourcesCard({
  resources: { machine, ready, lanes, tiles, counts },
}: {
  resources: MachineResources
}): React.JSX.Element {
  const { navigate } = useNavigation()
  return (
    <div className="space-y-4">
      {!ready && <p className="text-text-tertiary text-sm">{REMOTE_NOT_READY}</p>}
      {lanes && (
        <div>
          <p className="text-text-secondary mb-2 text-sm">
            {lanes.count} {lanes.count === 1 ? 'lane' : 'lanes'}
            {ready ? '' : ' · last known'}
          </p>
          {lanes.count > 0 && (
            <fieldset className="machine-lane-preview" aria-label="Lane preview" disabled={!ready}>
              {lanes.rows}
              {lanes.count > LANES_SHOWN && (
                <TooltipButton
                  className="machine-view-lanes"
                  onClick={() => navigate({ to: 'lanes', machine })}
                >
                  View all {lanes.count} lanes →
                </TooltipButton>
              )}
            </fieldset>
          )}
        </div>
      )}
      {tiles.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {tiles.map((key) => (
            <MachineResourceTile
              key={key}
              label={LABELS[key]}
              count={counts[key] ?? (ready ? 'loading' : 'failed')}
              disabled={!ready}
              onOpen={() => openMachinePage(key, machine)}
            />
          ))}
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
