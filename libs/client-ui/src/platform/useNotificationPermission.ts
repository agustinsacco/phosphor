import { useEffect, useState } from 'react'
export type NotificationPermissionState = NotificationPermission | 'unavailable'
const read = (): NotificationPermissionState =>
  typeof Notification === 'undefined' || !('serviceWorker' in navigator)
    ? 'unavailable'
    : Notification.permission

/** Reading never prompts. Only the explicit button requests this device's permission. */
export function useNotificationPermission() {
  const [permission, setPermission] = useState(read)
  const [error, setError] = useState('')
  useEffect(() => {
    const refresh = () => setPermission(read())
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  const request = (): void => {
    setError('')
    if (read() === 'unavailable') return
    void Notification.requestPermission()
      .then(setPermission)
      .catch(() => setError('Could not request notifications. Try again.'))
  }
  return { permission, request, error }
}
