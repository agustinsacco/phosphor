import { useCallback } from 'react'
import { usePlatform } from '@/platform/Platform'
import { AgentPolicyForm } from './AgentPolicyForm'
import { AgentChanges } from './AgentChanges'
import { PendingApprovals } from './PendingApprovals'
import { OpDenied, readPolicy, useOpsConnection } from './agentOps'
import { LoadError, useOpRead } from './useOpRead'

/** Host settings access and agent-control ops are independently granted. */
export function AgentControl({ machine }: { machine: string }) {
  const connection = useOpsConnection(machine)
  const { localLanes } = usePlatform()
  if (machine === 'local' ? !localLanes : !connection) return null
  return <Control key={`${machine}:${connection}`} machine={machine} />
}
function Control({ machine }: { machine: string }) {
  const load = useCallback(() => readPolicy(machine), [machine])
  const { data, error, reload } = useOpRead(load, machine, 'policy')
  if (
    machine === 'local' &&
    ((!data && !error) || (error instanceof OpDenied && error.code === 'unsupported'))
  )
    return null
  return (
    <div className="mt-6 space-y-6 border-t border-border pt-4">
      {error != null && <LoadError error={error} retry={reload} />}
      {data && <AgentPolicyForm machine={machine} {...data} reload={reload} />}
      <PendingApprovals machine={machine} />
      <AgentChanges machine={machine} />
    </div>
  )
}
