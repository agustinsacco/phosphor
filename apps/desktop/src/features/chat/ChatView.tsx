import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { ForkPickerModal } from './ForkPickerModal'
import { StatusStrip } from '@/features/extension-ui/ExtensionUiHosts'
import { CrashBanner, NoModelsBanner, RewoundBanner } from './banners'
import { RateLimitBanner } from './composer/RateLimitBanner'

/**
 * The chat column: banners, transcript, composer.
 *
 * It deliberately has no header of its own. Session title, workspace, branch,
 * and the pane switches all live in the window's single top bar
 * (src/app/TopBar.tsx) — a per-column header here could not know whether it was
 * the element sitting under the OS window controls, which is precisely how the
 * right-hand pane's buttons ended up rendering beneath them.
 */
export function ChatView({
  sessionId,
  workspacePath,
}: {
  sessionId: string
  workspacePath: string
}): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <CrashBanner sessionId={sessionId} workspacePath={workspacePath} />
      <NoModelsBanner sessionId={sessionId} />
      <RewoundBanner sessionId={sessionId} />
      <MessageList sessionId={sessionId} />
      {/* Both share the composer's horizontal gutter and maximum width: a
          right pane must narrow every surface above the composer together. */}
      <div className="shrink-0 px-6 pt-1">
        <RateLimitBanner sessionId={sessionId} className="mx-auto w-full max-w-3xl" />
      </div>
      <Composer sessionId={sessionId} workspacePath={workspacePath} />
      <StatusStrip sessionId={sessionId} />
      <ForkPickerModal sessionId={sessionId} />
    </div>
  )
}
