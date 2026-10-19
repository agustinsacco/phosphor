import type { ReactNode, RefObject } from 'react'
import { PhosphorLoader } from '@/components/PhosphorLoader'
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
        <div className="remote-workspace-heading">
          <PhosphorLoader size={36} decorative animated={false} />
          <h1>What are we working on?</h1>
          <p>Your workspace, wherever you are.</p>
        </div>
        <HostHome hostId={hostId} />
      </div>
      <RemoteStartView
        hostId={hostId}
        draftKey={draftKey}
        textareaRef={textareaRef}
        machinePicker={machinePicker}
      />
    </div>
  )
}
