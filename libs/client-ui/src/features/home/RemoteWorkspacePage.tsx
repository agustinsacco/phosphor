import type { ReactNode, RefObject } from 'react'
import { HostHome } from './HostHome'
import { RemoteStartView } from './RemoteStartView'
import './remoteStart.css'

/** Full remote start page, shared by Desktop and every browser viewport. */
export function RemoteWorkspacePage({
  hostId,
  draftKey,
  textareaRef,
  machinePicker,
}: {
  hostId: string
  draftKey?: string
  textareaRef?: RefObject<HTMLTextAreaElement | null>
  machinePicker?: ReactNode
}): React.JSX.Element {
  return (
    <div className="remote-workspace-page">
      <div className="remote-workspace-intro">
        <div className="remote-workspace-column">
          {/* First for reading order and heading levels; the stylesheet draws it under the orbit. */}
          <h1 className="remote-workspace-heading">What are we working on?</h1>
          <HostHome hostId={hostId} />
        </div>
      </div>
      <div className="remote-start">
        <RemoteStartView
          hostId={hostId}
          draftKey={draftKey}
          textareaRef={textareaRef}
          machinePicker={machinePicker}
        />
      </div>
    </div>
  )
}
