import { TooltipButton } from '@/components/Tooltip'
import type { ReactNode } from 'react'
import { findMentionDestination } from './composer/laneMentions'
import { useNavigation } from '@/navigation/Navigation'
import { usePlatform } from '@/platform/Platform'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { openSidebarConversation } from '@/features/sessions/completionActions'

export function LaneMentionChip({ href, children }: { href: string; children: ReactNode }) {
  const { navigate } = useNavigation()
  const { localLanes } = usePlatform()
  const open = (): void => {
    const dest = findMentionDestination(href, localLanes)
    if (!dest) useExtensionUiStore.getState().pushToast('This lane is unavailable.', 'error')
    else if ('meta' in dest) openSidebarConversation(dest.workspace, dest.meta)
    else navigate({ to: 'lane', lane: dest, pane: 'chat' })
  }
  return (
    <TooltipButton
      type="button"
      tooltip="Open lane"
      className="bg-accent/10 text-info hover:bg-accent/20 inline rounded px-1 font-medium"
      onClick={open}
    >
      {children}
    </TooltipButton>
  )
}
