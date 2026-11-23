import { formatCount } from '@/lib/format'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/form'
import { promptText } from '@/stores/prompt'
import { ipcErrorText } from '@shared/errors'
import { mutateBrain, useBrain } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import { tidyChangeToast } from '../tidy/tidyActions'
import type { BrainVisit } from './trail'

/** Read both records before confirming: a name alone cannot distinguish two people. */
export function MergeEntity({
  sourceId,
  target,
  onVisit,
}: {
  sourceId: string
  target: BrainVisit
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const load = useCallback(() => readMergeEntities(sourceId, target.id), [sourceId, target.id])
  const resource = useBrainResource(load)
  const [message, setMessage] = useState('')
  const [confirming, setConfirming] = useState(false)
  const first = useRef(true)
  const alive = useRef(true)
  const busy = useBrain((s) => s.saving)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const confirm = useCallback(async (): Promise<void> => {
    const data = resource.data
    if (!data) return
    setConfirming(true)
    const answer = await confirmMergeRecords(data.source.entity, data.destination.entity)
    if (!alive.current) return
    setConfirming(false)
    if (answer !== 'MERGE') return
    try {
      const result = await mutateBrain(() =>
        window.phosphor.invoke('brain:merge', sourceId, target.id, data.revision),
      )
      tidyChangeToast(result, `Merged into ${data.destination.entity.label}`)
      onVisit(target)
    } catch (cause) {
      resource.retry()
      try {
        const status = await window.phosphor.invoke('brain:status')
        if (alive.current)
          setMessage(
            status.revision !== data.revision
              ? 'Brain changed. Check this again.'
              : ipcErrorText(cause),
          )
      } catch (reloadError) {
        if (alive.current) setMessage(`${ipcErrorText(cause)} ${ipcErrorText(reloadError)}`)
      }
    }
  }, [resource, sourceId, target, onVisit])
  useEffect(() => {
    if (!resource.data || !first.current) return
    first.current = false
    void confirm()
  }, [resource.data, confirm])
  return (
    <div className="space-y-2 [overflow-wrap:anywhere]">
      {message && <p role="status">{message}</p>}
      {!resource.data ? (
        <p role="status">
          {resource.error || 'Loading both records…'}{' '}
          {resource.error && <Button onClick={resource.retry}>Retry</Button>}
        </p>
      ) : (
        <Button
          disabled={busy || confirming}
          onClick={() => {
            void confirm()
          }}
        >
          Review merge…
        </Button>
      )}
    </div>
  )
}

async function readMergeEntities(sourceId: string, targetId: string) {
  const status = await window.phosphor.invoke('brain:status')
  const [source, destination] = await Promise.all([
    window.phosphor.invoke('brain:entity', sourceId),
    window.phosphor.invoke('brain:entity', targetId),
  ])
  return { source, destination, revision: status.revision }
}
function confirmMergeRecords(
  a: Awaited<ReturnType<typeof readMergeEntities>>['source']['entity'],
  b: typeof a,
): Promise<string | undefined> {
  return promptText({
    title: `Merge ${a.label} into ${b.label}?`,
    message: `${a.label} · ${formatCount(a.memories, 'memory', 'memories')}: ${a.description || 'No description'}.\n${b.label} · ${formatCount(b.memories, 'memory', 'memories')}: ${b.description || 'No description'}.\nAll names, links and memories move to the target. The source entity is deleted. You can Undo this in Lanes › Recent changes. Type MERGE to confirm.`,
    submitLabel: 'Merge',
    placeholder: 'MERGE',
  })
}
