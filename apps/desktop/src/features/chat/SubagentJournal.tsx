import { useEffect, useState } from 'react'
import { Button } from '@/components/form'
import { errorText } from '@shared/errors'
import { recordedReply, subagentHistory } from './subagentHistory'
import { SUBAGENT_SUPERVISOR_REPLY_TYPE } from './subagentRuns'
import { SubagentNoticeItem } from './items/SubagentNotice'

/** Explicit read, not a second journal or a polling full-transcript service. */
export function SubagentJournal({
  sessionId,
  onInspect,
}: {
  sessionId: string
  onInspect: (runId: string) => void
}): React.JSX.Element {
  const [history, setHistory] = useState<ReturnType<typeof subagentHistory>>()
  const [error, setError] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let cancelled = false
    setHistory(undefined)
    setError(undefined)
    void window.phosphor
      .piCommand(sessionId, { type: 'get_entries' })
      .then((reply) => {
        if (cancelled) return
        if (!reply.success) throw new Error(reply.error ?? 'Recorded history is unavailable.')
        if (!reply.data) throw new Error('Recorded history is unavailable.')
        setHistory(subagentHistory(reply.data.entries, reply.data.leafId))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, refresh])
  return (
    <div className="max-h-[70vh] overflow-auto p-4 text-base">
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-text-secondary">
          Native questions, parent replies and results on this branch, including pre-compaction
          records. Historical requests are not proof of a current blocker. Launches and tool results
          remain in the conversation.
        </p>
        <Button size="sm" onClick={() => setRefresh((n) => n + 1)}>
          Refresh
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : !history ? (
        <p>Reading recorded history…</p>
      ) : (
        <>
          {history.omitted > 0 && (
            <p className="text-text-secondary mb-2">
              Showing the newest 200 records; {history.omitted} earlier records omitted.
            </p>
          )}
          {history.launches.length > 0 && (
            <section className="mb-4 space-y-2">
              <h3 className="font-medium">Recorded launches and resumes</h3>
              <p className="text-text-secondary">
                Historical receipts, not current liveness.{' '}
                {history.omittedLaunches > 0 &&
                  `${history.omittedLaunches} earlier launches omitted.`}
              </p>
              {history.launches.map((run) => (
                <div key={run.id} className="border-border rounded border p-2">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span>{run.label}</span>
                    {run.runId && (
                      <Button size="sm" onClick={() => onInspect(run.runId!)}>
                        Inspect run
                      </Button>
                    )}
                  </div>
                  <p className="text-text-secondary">{run.outcome}</p>
                  {run.task && (
                    <details>
                      <summary className="cursor-pointer">Delegated task</summary>
                      <pre className="whitespace-pre-wrap break-words">{run.task}</pre>
                    </details>
                  )}
                </div>
              ))}
            </section>
          )}
          <div className="space-y-2">
            {history.items
              .filter(
                (item) =>
                  item.customType !== SUBAGENT_SUPERVISOR_REPLY_TYPE ||
                  !history.items.some((question) => recordedReply(question, [item]) !== undefined),
              )
              .map((item) => (
                <SubagentNoticeItem
                  key={item.id}
                  item={item}
                  reply={recordedReply(item, history.items)}
                  onInspect={onInspect}
                />
              ))}
          </div>
          {!history.items.length && (
            <p className="text-text-secondary">
              No recorded coordination on this branch. Older extension versions may not journal
              parent replies.
            </p>
          )}
        </>
      )}
    </div>
  )
}
