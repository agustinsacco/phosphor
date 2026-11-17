import { useState } from 'react'
import type { BrainEntityView } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { Button } from '@/components/form'
import { formatCount } from '@/lib/format'
import { openBrainLane } from '../openBrainSource'

/** The lanes its memories came from, newest first, with how many each holds and a way back. */
export function ProfileLanes({
  view,
  onLane,
}: {
  view: BrainEntityView
  /** Show this lane's memories in the Memories tab. */
  onLane: (sessionId: string) => void
}): React.JSX.Element {
  const [opening, setOpening] = useState('')
  const [error, setError] = useState<{ sessionId: string; text: string } | null>(null)
  if (!view.sources.length)
    return <p className="text-text-tertiary py-3 text-sm">No lane has mentioned it yet.</p>
  const open = async (sessionId: string): Promise<void> => {
    setOpening(sessionId)
    setError(null)
    try {
      await openBrainLane(sessionId)
    } catch (cause) {
      setError({ sessionId, text: ipcErrorText(cause) })
    } finally {
      setOpening('')
    }
  }
  return (
    <table aria-label="Lanes" className="w-full table-fixed border-collapse text-sm">
      <tbody>
        {view.sources.map((source) => (
          <tr key={source.sessionId} className="border-border border-b align-top">
            <th scope="row" className="py-2 pr-3 text-left font-medium">
              {source.title}
              <span className="text-text-tertiary block font-normal">
                {formatCount(source.memories, 'memory', 'memories')}
              </span>
              {error?.sessionId === source.sessionId && (
                <span role="status" className="text-danger block font-normal">
                  {error.text}
                </span>
              )}
            </th>
            <td className="w-56 py-1.5 text-right">
              <span className="inline-flex flex-wrap justify-end gap-1">
                <Button size="xs" onClick={() => onLane(source.sessionId)}>
                  Its memories
                </Button>
                <Button
                  size="xs"
                  disabled={!!opening}
                  onClick={() => {
                    void open(source.sessionId)
                  }}
                >
                  {opening === source.sessionId ? 'Opening…' : 'Open lane'}
                </Button>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
