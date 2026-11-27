import { useState } from 'react'
import clsx from 'clsx'
import { BranchIcon } from '@/components/icons'
import { Chip, CHIP_MARK } from '@/components/form'
import { useHostTraits } from '@/platform/machineTraits'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { openRemoteComposer } from '@/features/home/remoteComposer'
import { BranchControl } from './BranchControl'

/**
 * A Host lane's branch, in the lane header's one branch slot. This Mac's service,
 * when ready, gets the native branch menu on the lane's folder. Any other Host, a
 * browser, or a reconnecting service shows the same chip read-only, from the Host's
 * lane summary, whose branch follows the lane folder after every run.
 */
export function HostLaneBranchControl({
  hostId,
  laneId,
}: {
  hostId: string
  laneId: string
}): React.JSX.Element | null {
  const { sameMachine } = useHostTraits(hostId)
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const lane = host?.lanes.find((item) => item.laneId === laneId)
  if (!lane) return null
  if (sameMachine && host?.state === 'ready')
    return <ServiceBranchControl hostId={hostId} cwd={lane.cwd} />
  if (!lane.branch) return null
  const repository = host?.repositories.find((item) => item.id === lane.repositoryId)
  return (
    <Chip
      className="bg-bg-secondary text-text-secondary shrink-0"
      data-testid="lane-branch"
      data-tooltip={
        lane.worktree
          ? `Worktree of ${repository?.name ?? 'Repository'} on ${machineLabel(hostId)}`
          : `Branch ${lane.branch}`
      }
    >
      {lane.worktree && <span className={clsx('bg-accent-soft text-accent', CHIP_MARK)}>wt</span>}
      <BranchIcon size={10} />
      <span className="max-w-36 truncate">{lane.branch}</span>
    </Chip>
  )
}

/** Only the native Git controls use this path; selecting a checkout still opens a Host composer. */
export function ServiceBranchControl({ hostId, cwd }: { hostId: string; cwd: string }) {
  const { sameMachine } = useHostTraits(hostId)
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [notice, setNotice] = useState('')
  if (!sameMachine || host?.state !== 'ready') return null
  const select = (path: string) => {
    const current = useRemoteLanesStore.getState().hosts[hostId]
    if (!current?.local || current.state !== 'ready') return
    const repo = current.repositories.find((r) => r.path === path)
    if (repo) {
      setNotice('')
      openRemoteComposer(hostId, repo.id)
    } else setNotice('Add this folder on the machine first.')
  }
  return (
    <>
      <BranchControl
        workspacePath={cwd}
        hostId={hostId}
        selectPath={select}
        configured={(path) => host.repositories.some((r) => r.path === path)}
      />
      {notice && <span role="status">{notice}</span>}
    </>
  )
}
