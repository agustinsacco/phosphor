import { Notification, type BrowserWindow } from 'electron'
import { piStubPath } from '../pi/stub'

/** The OS shows about this much; anything longer is the renderer's bug, not a reason to fail. */
const TITLE_MAX = 120
const BODY_MAX = 240

/** Held until settled: a collected Notification never reports its click. */
const showing = new Set<Notification>()

const clip = (text: unknown, max: number): string =>
  (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * Show a native notification for the renderer, only while its window is not
 * the focused one: in front of the user, the toast already says it. Resolves
 * true when the user clicks it, after bringing the window forward; false when
 * it closes unclicked, fails, cannot show, or the window goes away first.
 *
 * Never under the e2e pi stub, whose windows never focus and would otherwise
 * post to the developer's real notification centre.
 */
export function showNativeNotice(
  window: BrowserWindow | null,
  notice: { title: string; body: string },
): Promise<boolean> {
  const title = clip(notice?.title, TITLE_MAX)
  if (!window || window.isDestroyed() || window.isFocused() || !title) return Promise.resolve(false)
  if (piStubPath() || !Notification.isSupported()) return Promise.resolve(false)
  return new Promise((resolve) => {
    const notification = new Notification({ title, body: clip(notice?.body, BODY_MAX) })
    showing.add(notification)
    const settle = (clicked: boolean): void => {
      showing.delete(notification)
      window.removeListener('closed', gone)
      resolve(clicked)
    }
    const gone = (): void => settle(false)
    window.once('closed', gone)
    notification.once('click', () => {
      if (!window.isDestroyed()) {
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      }
      settle(!window.isDestroyed())
    })
    notification.once('close', () => settle(false))
    notification.once('failed', () => settle(false))
    notification.show()
  })
}
