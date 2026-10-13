import type { WebContents } from 'electron'
import { normalizeVoicePrefs } from '@shared/voice'
import { handle } from './handle'
import { voiceService } from '../voice'

/**
 * Voice input: prefs and download (Settings → Voice) and dictation (the
 * composer's microphone). A dictation belongs to the window that started it;
 * closing that window cancels it.
 */
export function registerVoiceHandlers(): void {
  const voice = voiceService()
  const watched = new WeakSet<WebContents>()

  handle('voice:status', () => voice.status())
  handle('voice:setPrefs', (_event, prefs) => voice.setPrefs(normalizeVoicePrefs(prefs)))
  handle('voice:start', async (event) => {
    const { sender } = event
    const id = sender.id
    if (!watched.has(sender)) {
      watched.add(sender)
      sender.once('destroyed', () => voice.cancel(id))
    }
    await voice.start(id)
  })
  handle('voice:audio', (event, samples) => voice.audio(event.sender.id, samples))
  handle('voice:stop', (event) => voice.stop(event.sender.id))
  handle('voice:cancel', (event) => voice.cancel(event.sender.id))

  void voice.init().catch(() => undefined)
}
