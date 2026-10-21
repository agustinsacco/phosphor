import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpLaneResult } from '@shared/mcp-inspection'
import { useSessionsStore } from '@/stores/sessions'
import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { ToolBrowser } from './ToolBrowser'

function useLaneInspection(sessionId: string, name: string) {
  const [result, setResult] = useState<McpLaneResult>()
  const [pending, setPending] = useState(false)
  const [slow, setSlow] = useState(false)
  const busy = useRef(false)
  const epoch = useRef(0)
  const run = useCallback(
    async (operation: 'inspect' | 'reconnect') => {
      if (busy.current) return
      busy.current = true
      const current = epoch.current
      setPending(true)
      setSlow(false)
      const timer = setTimeout(() => {
        if (current === epoch.current) setSlow(true)
      }, 30_000)
      try {
        const answer = await window.phosphor.invoke('mcp:laneControl', sessionId, name, operation)
        if (current === epoch.current) setResult(answer)
      } catch {
        if (current === epoch.current)
          setResult({
            ok: false,
            message: 'Could not inspect this lane. It may be busy or closed; retry when idle.',
          })
      } finally {
        clearTimeout(timer)
        busy.current = false
        if (current === epoch.current) {
          setPending(false)
          setSlow(false)
        }
      }
    },
    [sessionId, name],
  )
  useEffect(() => {
    void run('inspect')
    const timer = setInterval(() => {
      void run('inspect')
    }, 20_000)
    const invalidate = () => {
      epoch.current++
    }
    return () => {
      clearInterval(timer)
      invalidate()
    }
  }, [run])
  return { result, pending, slow, run }
}

export function LaneConnectorStatus({
  workspacePath,
  name,
}: {
  workspacePath?: string
  name: string
}): React.JSX.Element | null {
  const activeId = useSessionsStore((state) => state.activeSessionId)
  const lane = useSessionsStore((state) => (activeId ? state.live[activeId] : undefined))
  if (!activeId || !lane || lane.target?.kind === 'remote' || lane.workspacePath !== workspacePath)
    return null
  return <LaneStatus key={`${activeId}:${name}`} sessionId={activeId} name={name} />
}

function LaneStatus({ sessionId, name }: { sessionId: string; name: string }): React.JSX.Element {
  const { result, pending, slow, run } = useLaneInspection(sessionId, name)
  const report = result?.ok ? result.report : undefined
  return (
    <details className="border-border border-t px-3.5 py-2 text-sm">
      <TooltipSummary className="cursor-pointer">
        Selected lane{report ? ` · ${report.state} · ${report.tools.length} tools` : ''}
      </TooltipSummary>
      <p className="text-text-tertiary mt-2">
        Live connection in this lane only, separate from the independent test above. Reconnect uses
        this lane’s loaded configuration; saved config changes apply before its next turn.
      </p>
      {result && !result.ok && <p className="text-danger mt-2">{result.message}</p>}
      {report?.error && <p className="text-danger mt-2">{report.error}</p>}
      {slow && (
        <p role="status">
          Still waiting for native pi. New lane work stays blocked during a reconnect until it
          finishes.
        </p>
      )}
      <div className="my-2 flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => void run('inspect')}>
          Inspect lane
        </Button>
        <Button
          size="sm"
          disabled={pending || report?.state === 'disabled'}
          onClick={() => void run('reconnect')}
        >
          {pending ? 'Waiting…' : 'Reconnect in lane'}
        </Button>
      </div>
      {report && <ToolBrowser tools={report.tools} />}
    </details>
  )
}
