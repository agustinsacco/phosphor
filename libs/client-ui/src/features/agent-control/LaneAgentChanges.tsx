import { create } from 'zustand'
import { useEffect, useState } from 'react'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { Button } from '@/components/form'
import { AgentChanges } from './AgentChanges'
import { useAgentLaneScope } from './laneScope'
import { OpDenied, readPolicy, useOpsConnection } from './agentOps'

const useOpenLane = create<{ machine: string; lane: string } | null>(() => null)
function close() {
  useOpenLane.setState(null, true)
}
export function useAgentChangesItem(sessionId: string): ContextMenuItem[] {
  const { machine, lane } = useAgentLaneScope(sessionId)
  const probe = machine === 'local' && lane !== null
  const [served, setServed] = useState(false)
  useEffect(() => {
    setServed(false)
    if (!probe) return
    let seq = 0
    const check = () => {
      const id = ++seq
      void readPolicy('local').then(
        () => {
          if (seq === id) setServed(true)
        },
        (e) => {
          if (seq === id) setServed(!(e instanceof OpDenied && e.code === 'unsupported'))
        },
      )
    }
    check()
    const stop = window.phosphor?.onLocalMachineChanged?.((s) => {
      if (s.service === 'ready') check()
    })
    return () => {
      seq++
      stop?.()
    }
  }, [probe])
  return lane && (machine !== 'local' || served)
    ? [{ label: 'Agent changes…', onClick: () => useOpenLane.setState({ machine, lane }, true) }]
    : []
}
export function LaneChangesOverlay() {
  const scope = useOpenLane()
  const connection = useOpsConnection(scope?.machine ?? '')
  useEffect(() => {
    if (scope && scope.machine !== 'local' && !connection) close()
  }, [scope, connection])
  if (!scope || (scope.machine !== 'local' && !connection)) return null
  return (
    <ModalOverlay onClose={close}>
      <ModalPanel width={620} title="Agent changes" footer={<Button onClick={close}>Close</Button>}>
        <div className="max-h-[60vh] overflow-y-auto p-4">
          <AgentChanges key={scope.lane} {...scope} />
        </div>
      </ModalPanel>
    </ModalOverlay>
  )
}
