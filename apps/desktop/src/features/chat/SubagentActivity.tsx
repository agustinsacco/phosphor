import { useEffect, useState } from 'react'
import { isFleetActive, type FleetNode } from './subagentRuns'

/** Counters are reported; elapsed is derived only from an explicit native start. */
export function SubagentActivity({ node }: { node: FleetNode }): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!isFleetActive(node.state) || node.startedAt === undefined) return
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now())
    }, 1000)
    return () => clearInterval(timer)
  }, [node.state, node.startedAt])
  const end = node.endedAt ?? (isFleetActive(node.state) ? now : undefined)
  const seconds =
    node.startedAt !== undefined && end !== undefined
      ? Math.max(0, Math.floor((end - node.startedAt) / 1000))
      : undefined
  const parts = [
    node.toolCount === undefined ? undefined : `${node.toolCount} tools`,
    node.turnCount === undefined ? undefined : `${node.turnCount} turns`,
    seconds === undefined ? undefined : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`,
  ].filter(Boolean)
  return <span className="text-text-secondary w-full text-sm">{parts.join(' · ')}</span>
}
