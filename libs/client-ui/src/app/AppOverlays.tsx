import { BulkDeleteProgressPopover } from '@/features/sessions/BulkDeleteModal'
import { SessionRecoveryModals } from '@/features/sessions/SessionRecoveryModals'
import { ContextMenuHost } from '@/components/ContextMenu'
import { TextFieldMenu } from '@/features/writing/TextFieldMenu'
import { ExtensionDialogHost, ToastHost } from '@/features/extension-ui/ExtensionUiHosts'
import { PromptHost } from '@/components/PromptHost'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { SettingsModal } from '@/features/settings/SettingsModal'
import { FeedbackModal } from '@/features/feedback/FeedbackModal'
import { LaneLearningHost } from '@/features/brain/LaneLearningHost'

/** Shell-owned overlays survive sidebar visibility changes; learning has one projection owner. */
export function AppOverlays({
  workspacePath,
  ready,
}: {
  workspacePath: string
  ready: boolean
}): React.JSX.Element {
  return (
    <>
      <ContextMenuHost />
      <TextFieldMenu />
      <ExtensionDialogHost />
      <PromptHost />
      <ToastHost />
      <BulkDeleteProgressPopover />
      <SessionRecoveryModals />
      <LaneLearningHost ready={ready} />
      <CommandPalette key={workspacePath} workspacePath={workspacePath} />
      <SettingsModal />
      <FeedbackModal />
    </>
  )
}
