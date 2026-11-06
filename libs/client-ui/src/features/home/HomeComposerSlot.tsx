import type { ReactNode, RefObject } from 'react'
import { LocalHomeComposer } from './LocalHomeComposer'
import { RemoteStartView } from './RemoteStartView'
import { homeDraftKey } from '@/stores/drafts'

/**
 * What the home's composer machine offers: This Mac's composer, a Host's start view, or This
 * Mac's setup while it cannot start a lane. The setup sits under the machine picker, filling the
 * home (`wholeHome`) or the composer slot under a Host home.
 */
export function HomeComposerSlot({
  composerMachine,
  workspacePath,
  localSetup,
  textareaRef,
  machinePicker,
  wholeHome = false,
}: {
  composerMachine: string
  workspacePath: string
  localSetup?: ReactNode
  textareaRef: RefObject<HTMLTextAreaElement | null>
  machinePicker: ReactNode
  wholeHome?: boolean
}): React.JSX.Element {
  if (composerMachine === 'local' && localSetup)
    return (
      // The picker stays outside the scroll box, so its menu opens unclipped.
      <div className={wholeHome ? 'flex h-full min-h-0 flex-col pt-6' : undefined}>
        <div className="flex shrink-0 justify-center">{machinePicker}</div>
        <div className={wholeHome ? 'min-h-0 flex-1' : 'max-h-[50vh] overflow-y-auto'}>
          {localSetup}
        </div>
      </div>
    )
  if (composerMachine === 'local')
    return (
      <LocalHomeComposer
        workspacePath={workspacePath}
        textareaRef={textareaRef}
        machinePicker={machinePicker}
      />
    )
  return (
    <RemoteStartView
      key={`${composerMachine}:${workspacePath}`}
      hostId={composerMachine}
      draftKey={homeDraftKey(workspacePath)}
      textareaRef={textareaRef}
      machinePicker={machinePicker}
    />
  )
}
