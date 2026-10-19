import { useSyncExternalStore } from 'react'

interface InstallPrompt extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable' | 'failed' | 'busy'
let snapshot = { installed: false, available: false, busy: false }
let prompt: InstallPrompt | null = null
const listeners = new Set<() => void>()
let stop: (() => void) | undefined
const getSnapshot = (): typeof snapshot => snapshot
function update(patch: Partial<typeof snapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const listener of listeners) listener()
}

function listen(): () => void {
  let completed = false
  const display = window.matchMedia?.('(display-mode: standalone)')
  const checkDisplay = (): void =>
    update({
      installed:
        completed ||
        !!display?.matches ||
        ('standalone' in navigator && navigator.standalone === true),
    })
  const offer = (event: Event): void => {
    if (!('prompt' in event) || typeof event.prompt !== 'function' || !('userChoice' in event))
      return
    event.preventDefault()
    prompt = event as InstallPrompt
    update({ available: true })
  }
  const finish = (): void => {
    completed = true
    prompt = null
    update({ available: false, installed: true })
  }
  checkDisplay()
  window.addEventListener('beforeinstallprompt', offer)
  window.addEventListener('appinstalled', finish)
  display?.addEventListener?.('change', checkDisplay)
  return () => {
    window.removeEventListener('beforeinstallprompt', offer)
    window.removeEventListener('appinstalled', finish)
    display?.removeEventListener?.('change', checkDisplay)
    prompt = null
    update({ available: false })
  }
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) stop = listen()
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      stop?.()
      stop = undefined
    }
  }
}

/** A single browser-owned prompt is shared by all entrypoints; acceptance isn't installation. */
async function install(): Promise<InstallOutcome> {
  if (snapshot.busy) return 'busy'
  const request = prompt
  if (!request) return 'unavailable'
  prompt = null
  update({ available: false, busy: true })
  try {
    await request.prompt()
    return (await request.userChoice).outcome
  } catch {
    return 'failed'
  } finally {
    update({ busy: false })
  }
}
export function useInstallApp() {
  return { ...useSyncExternalStore(subscribe, getSnapshot), install }
}

export function installInstructions(userAgent: string): readonly string[] {
  if (
    /iPhone|iPad|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1)
  )
    return [
      'Open Phosphor in Safari.',
      'Tap Share, then Add to Home Screen.',
      'Enable Open as Web App if offered, then tap Add.',
    ]
  if (/Android/i.test(userAgent))
    return [
      'Open Phosphor in Chrome.',
      'Open the browser menu and choose Install app or Add to Home screen.',
      'Launch Phosphor from the new home-screen icon.',
    ]
  return [
    'Open the browser menu and choose Install Phosphor or Install app.',
    'If installation is not offered, try Chrome, Edge or Safari and follow that browser’s Add to Dock or installation option.',
  ]
}
