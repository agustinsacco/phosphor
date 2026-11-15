import { BulkDeleteProgressPopover } from '@/features/sessions/BulkDeleteModal'
import { SessionRecoveryModals } from '@/features/sessions/SessionRecoveryModals'
import { ContextMenuHost } from '@/components/ContextMenu'
import { TextFieldMenu } from '@/features/writing/TextFieldMenu'
import { ExtensionDialogHost, ToastHost } from '@/features/extension-ui/ExtensionUiHosts'
import { PromptHost } from '@/components/PromptHost'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { SettingsModal } from '@/features/settings/SettingsModal'
import { FeedbackModal } from '@/features/feedback/FeedbackModal'
import { useBrainSync } from '@/features/brain/useBrain'
import { attachPrTransitions } from '@/stores/prTransitions'
import { useEffect } from 'react'

/** Shell-owned overlays survive sidebar visibility changes. */
export function AppOverlays({
  workspacePath,
  ready,
}: {
  workspacePath: string
  ready: boolean
}): React.JSX.Element {
  useBrainSync(ready)
  // PR change notices: the toast, the drawer and, in the background, macOS.
  useEffect(() => attachPrTransitions(), [])
  return (
    <>
      <ContextMenuHost />
      <TextFieldMenu />
      <ExtensionDialogHost />
      <PromptHost />
      <ToastHost />
      <BulkDeleteProgressPopover />
      <SessionRecoveryModals />
      <CommandPalette key={workspacePath} workspacePath={workspacePath} />
      <SettingsModal />
      <FeedbackModal />
    </>
  )
}
