import { useRef } from 'react'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { Button } from '@/components/form'
import { toImageContents } from '@/features/chat/attachments'
import { StartingChat } from '@/features/home/StartingChat'
import { useNavigation } from '@/navigation/Navigation'
import { dismissLaneCreate, editLaneCreate, useLaneCreatesStore } from '@/stores/laneCreates'
import type { LaneCreate } from '@/stores/laneCreates'

/**
 * A New lane placeholder on screen, the same in both shells (`OpeningLane` on
 * Desktop, `CompactNew` in the browser): the message as it will sit in the
 * transcript, under the opening view's loader. A failed create keeps the
 * message and says why, with Edit and retry and Dismiss.
 */
export function LaneCreateView({
  id,
  leaving = false,
}: {
  id: string
  leaving?: boolean
}): React.JSX.Element | null {
  const { navigate } = useNavigation()
  const current = useLaneCreatesStore((s) => s.creates[id])
  // The create is dropped as its lane takes over; the view fades out as it was.
  const last = useRef<LaneCreate | undefined>(current)
  if (current) last.current = current
  const create = last.current
  if (!create) return null
  const starting = {
    workspacePath: `create:${create.id}`,
    prompt: create.text,
    images: toImageContents(create.attachments),
    phase: 'starting' as const,
  }
  const failed = !!current?.failure
  return (
    <div
      data-testid="opening-lane"
      data-leaving={leaving || undefined}
      aria-hidden={leaving || undefined}
      aria-busy={!leaving && !failed}
      className="opening-lane bg-bg absolute inset-0 z-20"
    >
      <StartingChat starting={starting}>
        <div className="flex flex-col items-center gap-2 px-6 pb-8 pt-4 text-center">
          <PhosphorLoader decorative animated={!failed} />
          {failed ? (
            <>
              <p role="alert" className="text-text-secondary text-base">
                {current.failure}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    editLaneCreate(id)
                    navigate({ to: 'new', machine: create.hostId })
                  }}
                >
                  Edit and retry
                </Button>
                <Button
                  onClick={() => {
                    dismissLaneCreate(id)
                    navigate({ to: 'new', machine: create.hostId })
                  }}
                >
                  Dismiss
                </Button>
              </div>
            </>
          ) : (
            <span className="text-text-secondary text-base" data-testid="starting-chat-phase">
              Starting lane…
            </span>
          )}
        </div>
      </StartingChat>
    </div>
  )
}
