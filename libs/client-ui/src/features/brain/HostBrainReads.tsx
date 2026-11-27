import type { BrainTidyOperation } from '@shared/brain-tidy'
import { useState } from 'react'
import type { HostBrainJob } from '@shared/host-brain'
import type { HostBrainRequest } from '@shared/host-brain-request'
import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { changeRows } from './changes/changeRows'
import { ChangeLine } from './changes/WhatChanged'
import { useBrainRequest, type ReadyBrainSurface } from './useHostBrain'

export function HostBrainReads({
  brain,
  openRead,
}: {
  brain: ReadyBrainSurface
  openRead: (id: string) => void
}) {
  const changes = useBrainRequest<'brain:tidyChanges'>(brain, {
    method: 'brain:tidyChanges',
    args: [50],
  })
  const { busy, error, act } = useReadActions(brain, changes.retry)
  const canWrite = brain.access.includes('configure')
  const mayOpenRead = brain.access.includes('evidence') ? openRead : undefined
  const { generation, revision, jobs, agent } = brain.status
  const expected = { generation, revision }
  const defragRunning = agent.run && ['queued', 'running'].includes(agent.run.state)
  return (
    <section aria-label="Reads and changes" className="space-y-3">
      {error && (
        <p role="alert">The Host did not confirm that action. Refresh before trying again.</p>
      )}
      <h2>Reads</h2>
      <ul>
        {jobs.map((job) => (
          <ReadRow
            key={job.id}
            job={job}
            openRead={mayOpenRead}
            busy={busy}
            run={canWrite ? (method) => void act({ method, args: [job.id], expected }) : undefined}
          />
        ))}
      </ul>
      <h2>What changed</h2>
      {canWrite && (
        <Button
          disabled={busy}
          onClick={() =>
            void act({ method: defragRunning ? 'brain:defragStop' : 'brain:defrag', args: [] })
          }
        >
          {defragRunning ? 'Stop Defrag' : 'Defrag'}
        </Button>
      )}
      {changes.error && (
        <p role="status">
          The Host did not provide changes. <Button onClick={changes.retry}>Retry</Button>
        </p>
      )}
      {changes.data && (
        <HostChangeList
          rows={changeRows(changes.data.items)}
          busy={busy}
          openRead={mayOpenRead}
          undo={
            canWrite && changes.data.revision === revision
              ? (id) => void act({ method: 'brain:tidyUndo', args: [id, revision], expected })
              : undefined
          }
          undoRun={
            canWrite && changes.data.revision === revision
              ? (id) => void act({ method: 'brain:undoRun', args: [id], expected })
              : undefined
          }
        />
      )}
    </section>
  )
}

function ReadRow({
  job,
  openRead,
  busy,
  run,
}: {
  job: HostBrainJob
  openRead?: (id: string) => void
  busy: boolean
  run?: (method: 'brain:retry' | 'brain:cancel') => void
}) {
  return (
    <li>
      {job.title} · {job.state}{' '}
      {openRead && (
        <Button size="xs" onClick={() => openRead(job.id)}>
          Read record
        </Button>
      )}{' '}
      {run && job.state === 'failed' && (
        <Button size="xs" disabled={busy} onClick={() => run('brain:retry')}>
          Retry read
        </Button>
      )}{' '}
      {run && ['queued', 'waiting', 'running', 'failed'].includes(job.state) && (
        <Button size="xs" disabled={busy} onClick={() => run('brain:cancel')}>
          {job.state === 'failed' ? 'Dismiss' : 'Cancel read'}
        </Button>
      )}
    </li>
  )
}

function HostChangeList({
  rows,
  busy,
  openRead,
  undo,
  undoRun,
}: {
  rows: ReturnType<typeof changeRows>
  busy: boolean
  openRead?: (id: string) => void
  undo?: (id: string) => void
  undoRun?: (id: string) => void
}) {
  if (!rows.length) return <p>Nothing changed yet.</p>
  return (
    <ul>
      {rows.map((row) => {
        const line = (change: BrainTidyOperation) => (
          <ChangeLine
            key={change.id}
            change={change}
            busy={busy}
            onOpenRead={openRead}
            onUndo={undo && (() => undo(change.id))}
          />
        )
        return row.type === 'change' ? (
          line(row.change)
        ) : (
          <li key={row.runId}>
            <details>
              <TooltipSummary>Brain Agent run · {row.changes.length} changes</TooltipSummary>
              <ul>{row.changes.map(line)}</ul>
            </details>
            {undoRun && row.changes.some((change) => change.undoable && !change.undoneAt) && (
              <Button size="xs" disabled={busy} onClick={() => undoRun(row.runId)}>
                Undo run
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function useReadActions(brain: ReadyBrainSurface, retry: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const act = async (request: HostBrainRequest) => {
    if (busy) return
    setBusy(true)
    setError(false)
    try {
      await brain.invoke(request)
      await brain.refresh()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
      retry()
    }
  }
  return { busy, error, act }
}
