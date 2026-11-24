import { useCallback, useState } from 'react'
import { Button } from '@/components/form'
import { pendingConfirms, runAgentOp } from './agentOps'
import { Review } from './AgentConfirmSheet'
import { LoadError, useOpRead } from './useOpRead'

export function PendingApprovals({ machine }: { machine: string }) {
  const load = useCallback(() => pendingConfirms(machine), [machine])
  const { data, error, reload } = useOpRead(load, machine, 'confirm', true)
  const [selected, setSelected] = useState<string | null>(null)
  const info = data?.find((i) => i.confirmId === selected)
  return (
    <section>
      <h3 className="font-semibold">Pending approvals</h3>
      {error != null && <LoadError error={error} retry={reload} />}
      {data?.length === 0 && <p>No requests waiting for approval.</p>}
      <ul>
        {data?.map((i) => (
          <li key={i.confirmId} className="flex items-center justify-between gap-2 py-2">
            <span>
              {i.title} · {i.origin.label}
            </span>
            <Button onClick={() => setSelected(i.confirmId)}>Review</Button>
          </li>
        ))}
      </ul>
      {info && (
        <Review
          key={info.digest}
          info={info}
          onClose={() => setSelected(null)}
          answer={async (approved) => {
            await runAgentOp(machine, approved ? 'confirm.approve' : 'confirm.deny', {
              confirmId: info.confirmId,
            })
            setSelected(null)
            reload()
          }}
        />
      )}
    </section>
  )
}
