import { sessionEventChannel } from '@shared/ipc'
import type { SessionPush } from '@shared/models'
import { trimForRenderer } from './event-trim'
import { broadcast } from '../broadcast'

export function desktopSessionSink(
  sessionId: string,
  target?: Pick<Electron.WebContents, 'isDestroyed' | 'send'>,
  unattended: () => boolean = () => false,
  privateProcessor = false,
): (payload: SessionPush) => void {
  const channel = sessionEventChannel(sessionId)
  return (payload) => {
    // Brain owns its live stream; its UI reads controlled transcripts, never lane pushes.
    if (privateProcessor) return
    // Unattended dialogs stay with the routine runner, not renderer OAuth flows.
    if (
      unattended() &&
      payload.kind === 'extension-ui' &&
      ['input', 'confirm', 'select', 'editor'].includes(payload.request.method)
    )
      return
    let push = payload
    if (payload.kind === 'event') {
      const event = trimForRenderer(payload.event)
      if (event !== payload.event) push = { kind: 'event', event }
    }
    if (target) {
      if (!target.isDestroyed()) target.send(channel, push)
    } else broadcast(channel, push)
  }
}
