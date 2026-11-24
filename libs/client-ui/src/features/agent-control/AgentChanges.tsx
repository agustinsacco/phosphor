import { useCallback, useState } from 'react'
import { Button } from '@/components/form'
import { readChanges, runAgentOp } from './agentOps'
import { LoadError, useOpAction, useOpRead } from './useOpRead'

export function AgentChanges({ machine, lane }: { machine: string; lane?: string }) {
  const [pages, setPages] = useState<string[]>([])
  const page = pages.at(-1)
  const load = useCallback(() => readChanges(machine, lane, page), [machine, lane, page])
  const { data, error, reload } = useOpRead(load, machine, 'audit')
  const action = useOpAction()
  return (
    <section>
      <h3 className="font-semibold">
        {lane ? 'Agent changes in this lane' : 'Agent changes on this machine'}
      </h3>
      {error != null && <LoadError error={error} retry={reload} />}
      {data?.rows.length === 0 && <p>No agent changes.</p>}
      <ul className="divide-border divide-y">
        {data?.rows.map((row) => (
          <li key={row.id} className="space-y-1 py-2">
            <strong>{row.op.split('.').join(' › ')}</strong> · {row.decision}
            {row.applies && ` · ${row.applies}`}
            <p className="text-text-secondary">
              {new Date(row.at).toLocaleString()} · {row.principal} {row.laneTitle ?? row.laneRef}
            </p>
            {row.reason && <p>Agent’s reason: {row.reason}</p>}
            <p>{row.result}</p>
            {row.undo && !row.undoneBy && (
              <Button
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await runAgentOp(machine, 'audit.undo', { auditId: row.id })
                    reload()
                  })
                }
              >
                Undo
              </Button>
            )}
            {row.undoneBy && <p>Undone by {row.undoneBy}</p>}
          </li>
        ))}
      </ul>
      {action.error && <p role="alert">{action.error}</p>}
      {pages.length > 0 && <Button onClick={() => setPages((p) => p.slice(0, -1))}>Newer</Button>}
      {data?.next && <Button onClick={() => setPages([...pages, data.next!])}>Older</Button>}
    </section>
  )
}
