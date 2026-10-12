import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/form'
import { useChatStore } from '@/stores/chat'
import { useLayoutStore } from '@/stores/layout'
import { useArtifactsStore } from '@/stores/artifacts'
import { SNAPSHOT_COMMAND } from '@phosphor/pi-extensions/subagent-snapshot'
import type { SubagentInspection } from './subagentInspect'
import type { SubagentTarget } from './subagentView'
import { saveSubagentSnapshot } from './subagentSnapshot'
import { steerSubagent } from './subagentSteer'

export function SubagentActions({
  sessionId,
  target,
  inspection,
  readAt,
  active,
}: {
  sessionId: string
  target: SubagentTarget
  inspection: SubagentInspection
  readAt: string
  active: boolean
}): React.JSX.Element {
  const meta = useChatStore((s) => s.sessions[sessionId]?.meta)
  const commands = useChatStore((s) => s.sessions[sessionId]?.commands)
  const supported = (name: string): boolean =>
    !!commands?.some((c) => c.name === name && c.source === 'extension')
  const messageId = useId()
  const [steering, setSteering] = useState(false)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [saved, setSaved] = useState<string>()
  const [error, setError] = useState<string>()
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    controller.current = new AbortController()
    return () => controller.current?.abort()
  }, [])
  const act = async (save: boolean): Promise<void> => {
    setPending(true)
    setError(undefined)
    const signal = controller.current!.signal
    try {
      if (save) {
        if (!meta?.sessionId) throw new Error('Session identity is not available yet.')
        const id = await saveSubagentSnapshot(
          sessionId,
          { sourceSessionId: meta.sessionId, ...target, readAt, inspection },
          signal,
        )
        if (!signal.aborted) setSaved(id)
        // Make the existing artifact index catch up even though no model turn ended.
        if (meta.sessionFile)
          void window.phosphor.invoke('artifacts:forSession', meta.sessionFile).catch(() => {})
      } else {
        await steerSubagent(sessionId, target, message)
        if (!signal.aborted) {
          setSteering(false)
          setNotice(
            'Steering requested. The native receipt records delivery, not proof the child acted on it.',
          )
        }
      }
    } catch (error) {
      if (!signal.aborted) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (!signal.aborted) setPending(false)
    }
  }
  return (
    <div className="border-border mt-4 space-y-2 border-t pt-3">
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-text-secondary">
          {notice}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending || !meta?.sessionId || !supported(SNAPSHOT_COMMAND)}
          onClick={() => void act(true)}
          title="Save this bounded preview, not a full transcript"
        >
          Save snapshot
        </Button>
        {saved && (
          <Button
            onClick={() => {
              useArtifactsStore.getState().select(sessionId, saved)
              useLayoutStore.getState().setRightPane('artifacts', sessionId)
            }}
          >
            View saved snapshot
          </Button>
        )}
        {active && (
          <Button
            disabled={pending || !supported('subagents-steer')}
            onClick={() => setSteering(!steering)}
          >
            Steer…
          </Button>
        )}
      </div>
      {!supported(SNAPSHOT_COMMAND) && (
        <p className="text-text-secondary">
          Restart this lane’s Pi process to enable snapshot saving.
        </p>
      )}
      {saved && (
        <p role="status" className="text-text-secondary">
          Saved in Artifacts. This copy survives compaction and expiry of the child’s temporary
          output.
        </p>
      )}
      {steering && (
        <div className="space-y-2">
          <p>
            Message this exact target:{' '}
            <span className="break-all font-mono text-sm">
              {target.runId}
              {target.childId ? ` / ${target.childId}` : ''}
            </span>
            . Normal chat still goes to the parent.
          </p>
          <label className="block" htmlFor={messageId}>
            Steering message
          </label>
          <textarea
            id={messageId}
            className="border-border bg-bg w-full rounded border p-2"
            rows={3}
            maxLength={8000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <p className="text-text-secondary">
            The extension flattens whitespace. Sending does not answer a supervisor question.
          </p>
          <Button disabled={pending || !active || !message.trim()} onClick={() => void act(false)}>
            Send steering message
          </Button>
          <Button disabled={pending} onClick={() => setSteering(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}
