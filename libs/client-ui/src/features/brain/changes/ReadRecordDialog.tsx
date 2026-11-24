import { useCallback } from 'react'
import { Button } from '@/components/form'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { formatCount } from '@/lib/format'
import { relativeTime } from '@/lib/time'
import { useBrainResource } from '../useBrainResource'
import { ExtractionOutcomes } from '../BrainExtraction'
import { ExtractionCalls } from '../ExtractionCalls'
import { ExtractionSource } from '../ExtractionSource'

/** How a saved read was read: what it found, each call, and the lane it read. */
export function ReadRecordDialog({
  jobId,
  title,
  onClose,
  onMemory,
}: {
  jobId: string
  /** The lane's name until the record says it. */
  title: string
  onClose: () => void
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:extraction', jobId), [jobId])
  const { data, error, retry } = useBrainResource(load)
  const name = data?.source.title || title
  return (
    <ModalOverlay onClose={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`How ${name} was read`}>
        <ModalPanel
          width={760}
          title={`How ${name} was read`}
          subtitle={
            data &&
            [
              formatCount(data.memories.length, 'memory', 'memories'),
              data.job?.finishedAt ? `saved ${relativeTime(data.job.finishedAt)}` : '',
            ]
              .filter(Boolean)
              .join(' · ')
          }
          footer={<Button onClick={onClose}>Close</Button>}
        >
          <div className="max-h-[70vh] space-y-4 overflow-auto p-4 [overflow-wrap:anywhere]">
            {!data ? (
              <p role="status">
                {error || 'Loading the read…'}{' '}
                {error && (
                  <Button size="xs" onClick={retry}>
                    Retry
                  </Button>
                )}
              </p>
            ) : (
              <>
                <ExtractionOutcomes data={data} onMemory={onMemory} />
                <ExtractionCalls data={data} />
                <ExtractionSource source={data.source} />
              </>
            )}
          </div>
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}
