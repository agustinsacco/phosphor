import { useState } from 'react'
import { useHostTraits } from '@/platform/machineTraits'
import { useSessionHostLane, useRemoteLanesStore } from '@/stores/remoteLanes'
import { openRemoteComposer } from '@/features/home/remoteComposer'
import { BranchControl } from './BranchControl'

/** Only the native Git controls use this path; selecting a checkout still opens a Host composer. */
export function ServiceLaneBranchControl({ sessionId }: { sessionId: string }) {
  const remote = useSessionHostLane(sessionId)
  return remote?.lane && <ServiceBranchControl hostId={remote.hostId} cwd={remote.lane.cwd} />
}

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
        selectPath={select}
        configured={(path) => host.repositories.some((r) => r.path === path)}
      />
      {notice && <span role="status">{notice}</span>}
    </>
  )
}
