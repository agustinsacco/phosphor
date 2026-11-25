import { useEffect, useState } from 'react'
import { hostIdOfPath } from '@phosphor/shared/remote-host'
import { activeRun, type RoutineRun } from '@phosphor/shared/routines'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'
import { Button } from '@/components/form'
import { ModalOverlay } from '@/components/Modal'
import { runAgentOp } from '../agent-control/agentOps'

function SavedOutput({ host, runId, close }: { host: string; runId: string; close(): void }) {
  const [pages, setPages] = useState<string[]>([])
  const [attempt, retry] = useState(0)
  const [result, setResult] = useState<{ content: string; next?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const page = pages.at(-1)
  useEffect(() => {
    let current = true
    setError(null)
    setResult(null)
    async function read() {
      try {
        const { data, next } = await runAgentOp(host, 'routine.history', { runId }, page)
        if (!machineRecord(data) || typeof data.content !== 'string')
          throw Error('The Host returned unreadable output.')
        if (current) setResult({ content: data.content, next })
      } catch (e) {
        if (current) setError(e instanceof Error ? e.message : 'Could not load run output.')
      }
    }
    void read()
    return () => {
      current = false
    }
  }, [host, runId, page, attempt])
  return (
    <ModalOverlay onClose={close}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Routine output"
        className="bg-bg border-border w-[min(800px,90vw)] rounded-lg border p-4"
      >
        <h2 className="text-lg font-semibold">Routine output</h2>
        {error ? (
          <p role="alert">
            {error} <Button onClick={() => retry(attempt + 1)}>Retry</Button>
          </p>
        ) : (
          <pre
            key={page}
            className="my-3 max-h-[65vh] overflow-auto whitespace-pre-wrap break-words"
          >
            {result ? result.content || 'No messages saved.' : 'Loading output…'}
          </pre>
        )}
        <div className="flex justify-end gap-2">
          {page && <Button onClick={() => setPages(pages.slice(0, -1))}>Previous</Button>}
          {result?.next && <Button onClick={() => setPages([...pages, result.next!])}>Next</Button>}
          <Button onClick={close}>Close</Button>
        </div>
      </section>
    </ModalOverlay>
  )
}

export function RunOutputAction({
  run,
  busy,
  onContinue,
}: {
  run: RoutineRun
  busy: boolean
  onContinue(): void
}) {
  const [open, setOpen] = useState(false)
  const host = hostIdOfPath(run.id)
  if (host && !run.outputLaneId) {
    if (!run.savedOutput)
      return (
        <span className="text-text-tertiary max-w-48 text-sm">
          Output not available from this machine yet
        </span>
      )
    return (
      <>
        <Button size="sm" disabled={busy} onClick={() => setOpen(true)}>
          View output
        </Button>
        {open && (
          <SavedOutput
            host={host}
            runId={run.id.slice(run.id.indexOf('/') + 1)}
            close={() => setOpen(false)}
          />
        )}
      </>
    )
  }
  return (
    <Button
      size="sm"
      disabled={busy || (!run.outputLaneId && !run.sessionId && !run.sessionPath)}
      onClick={onContinue}
    >
      {activeRun(run) ? 'Open running lane' : 'Continue lane'}
    </Button>
  )
}
