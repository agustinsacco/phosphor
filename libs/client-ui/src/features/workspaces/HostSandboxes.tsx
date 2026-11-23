import { useEffect, useState } from 'react'
import { parseOpsJobData } from '@phosphor/shared/host-protocol-ops'
import { Button } from '@/components/form'
import { runAgentOp } from '@/features/agent-control/agentOps'
import { promptChoice, promptText } from '@/stores/prompt'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

interface Sandbox {
  name: string
  path: string
}
function sandbox(value: unknown): value is Sandbox {
  return (
    !!value &&
    typeof value === 'object' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'path' in value &&
    typeof value.path === 'string'
  )
}

/** Never interpret a Host sandbox path on this device. The Host that listed it owns the mutation. */
function useSandboxActions(hostId: string) {
  const [rows, setRows] = useState<Sandbox[]>([])
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState('')
  const generation = useRemoteLanesStore((s) => s.hosts[hostId]?.connectionToken)
  useEffect(() => {
    let current = true
    setError('')
    setRows([])
    void runAgentOp(hostId, 'sandbox.list')
      .then(({ data }) => {
        if (!Array.isArray(data) || !data.every(sandbox)) throw new Error()
        if (current) setRows(data)
      })
      .catch(() => {
        if (current) setError('Could not list sandboxes.')
      })
    return () => {
      current = false
    }
  }, [hostId, generation, refresh])

  async function mutate(op: 'sandbox.create' | 'sandbox.rename' | 'sandbox.delete', row?: Sandbox) {
    setBusy(true)
    setError('')
    try {
      const args = await sandboxArgs(op, row)
      if (
        !args ||
        useRemoteLanesStore.getState().hosts[hostId]?.state !== 'ready' ||
        useRemoteLanesStore.getState().hosts[hostId]?.connectionToken !== generation
      )
        return
      const { data } = await runAgentOp(hostId, op, args)
      const started = parseOpsJobData(data)
      if (started) setJob(started.jobId)
      else setRefresh((n) => n + 1)
    } catch {
      setError('The Host could not confirm this change. Refresh before retrying.')
    } finally {
      setBusy(false)
    }
  }
  async function checkJob() {
    setBusy(true)
    try {
      const { data } = await runAgentOp(hostId, 'job.status', { jobId: job })
      if (!data || typeof data !== 'object' || !('state' in data)) throw new Error()
      if (data.state === 'running' || data.state === 'queued') return
      setJob('')
      if (data.state === 'done') setRefresh((n) => n + 1)
      else setError('The sandbox job did not complete. Refresh before retrying.')
    } catch {
      setError('Could not check the sandbox job.')
    } finally {
      setBusy(false)
    }
  }
  return { rows, busy, job, error, mutate, checkJob, refresh: () => setRefresh((n) => n + 1) }
}
export function HostSandboxes({ hostId }: { hostId: string }): React.JSX.Element {
  const { rows, busy, job, error, mutate, checkJob, refresh } = useSandboxActions(hostId)
  const disabled = busy || !!job
  return (
    <section aria-label="Sandboxes" className="space-y-2">
      <h3 className="font-medium">Sandboxes</h3>
      <Button size="sm" disabled={disabled} onClick={() => void mutate('sandbox.create')}>
        New sandbox…
      </Button>
      <Button size="sm" disabled={busy} onClick={refresh}>
        Refresh sandboxes
      </Button>
      {rows.map((row) => (
        <div key={row.path} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
          <Button size="sm" disabled={disabled} onClick={() => void mutate('sandbox.rename', row)}>
            Rename…
          </Button>
          <Button size="sm" disabled={disabled} onClick={() => void mutate('sandbox.delete', row)}>
            Delete sandbox…
          </Button>
        </div>
      ))}
      {job && (
        <div role="status">
          Sandbox job started.{' '}
          <Button size="sm" disabled={busy} onClick={() => void checkJob()}>
            Check status
          </Button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

async function sandboxArgs(op: string, row?: Sandbox): Promise<Record<string, string> | undefined> {
  if (op === 'sandbox.delete' && row) {
    const yes = await promptChoice({
      title: `Delete ${row.name}?`,
      message: 'Delete the sandbox folder and its chats. This cannot be undone.',
      choices: [{ value: 'delete', label: 'Delete sandbox' }],
    })
    return yes === 'delete' ? { path: row.path } : undefined
  }
  const name = (
    await promptText({
      title: row ? `Rename ${row.name}` : 'New sandbox',
      initialValue: row?.name,
      submitLabel: row ? 'Rename' : 'Create',
    })
  )?.trim()
  return name ? { ...(row ? { path: row.path } : {}), name } : undefined
}
