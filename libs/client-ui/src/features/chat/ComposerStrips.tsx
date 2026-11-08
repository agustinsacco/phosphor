import { memo } from 'react'
import { WidgetSlot } from '@/features/extension-ui/ExtensionUiHosts'
import { BackgroundWorkIndicator } from './BackgroundWorkIndicator'
import { BootingIndicator } from './BootingIndicator'
import { QueueChips } from './composer/QueueChips'
import { RateLimitBanner } from './composer/RateLimitBanner'
import { RetryStrip } from './RetryStrip'
import { AgentLaunchStrip, WorkingIndicator } from './WorkingIndicator'

/**
 * The status strips above the field. Memoised on the session id: they read
 * the chat store directly, so the draft changing is never a reason to render
 * them again.
 */
export const ComposerStrips = memo(function ComposerStrips({
  sessionId,
}: {
  sessionId: string
}): React.JSX.Element {
  return (
    <>
      <RateLimitBanner sessionId={sessionId} />
      <WorkingIndicator sessionId={sessionId} />
      <BootingIndicator sessionId={sessionId} />
      <BackgroundWorkIndicator sessionId={sessionId} />
      <AgentLaunchStrip sessionId={sessionId} />
      <RetryStrip sessionId={sessionId} />
      <WidgetSlot sessionId={sessionId} placement="aboveEditor" />
      <QueueChips sessionId={sessionId} />
    </>
  )
})
