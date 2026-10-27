import { app } from 'electron'
import Store from 'electron-store'
import { createUsagePing, type DesktopUsagePing, type UsageRecord } from './ping'

let service: DesktopUsagePing | null = null

/**
 * The app's one usage ping. Its marks live in their own file, apart from the
 * renderer's prefs, and the store is built on first use, like `prefs()`, so
 * E2E can redirect userData first.
 */
export function usagePing(): DesktopUsagePing {
  if (service) return service
  const store = new Store<{ record?: UsageRecord }>({ name: 'usage-ping' })
  service = createUsagePing({
    packaged: app.isPackaged,
    env: process.env,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    load: () => store.get('record'),
    save: (record) => store.set('record', record),
    // Node's fetch, never `net.fetch`: no Electron session, so no cookies or proxy auth.
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    random: Math.random,
    setTimeout: (run, ms) => setTimeout(run, ms),
    setInterval: (run, ms) => setInterval(run, ms),
  })
  return service
}
