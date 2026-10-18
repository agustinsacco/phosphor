// Type-only: erased at compile time, so the runtime import below stays lazy.
import type * as ElectronUpdater from 'electron-updater'
import type { UpdateEvent } from './update-state'

/**
 * The `electron-updater` path: its lazy import, a check, and its events.
 *
 * Holds no state. Every event is handed to the `apply` callback `updater.ts`
 * passes in, which owns the reducer state and the broadcast.
 */

export type ApplyUpdateEvent = (event: UpdateEvent) => void

/**
 * `electron-updater` is CommonJS and the packaged main bundle is ESM
 * (`"type": "module"`), so its exports arrive under `.default`. Destructuring
 * `autoUpdater` off the namespace yields **undefined** — Node's lexer lists the
 * name but the value is a lazy getter that only exists on the CJS exports
 * object. The result was `TypeError: Cannot set properties of undefined
 * (setting 'autoDownload')` on the very first check in a packaged build, i.e.
 * self-updating never worked outside dev, where `updater.ts` never imports it.
 */
export async function importUpdater(): Promise<typeof ElectronUpdater> {
  const mod = (await import('electron-updater')) as unknown as {
    default?: typeof ElectronUpdater
  } & typeof ElectronUpdater
  return mod.default ?? mod
}

export async function checkWithUpdater(apply: ApplyUpdateEvent): Promise<void> {
  apply({ type: 'check-started' })
  try {
    const { autoUpdater } = await importUpdater()
    await autoUpdater.checkForUpdates()
  } catch (error) {
    console.warn('[Phosphor] update check failed:', error)
    apply({ type: 'error' })
  }
}

export async function wireUpdaterEvents(apply: ApplyUpdateEvent): Promise<void> {
  const { autoUpdater } = await importUpdater()

  // Downloading is automatic; INSTALLING never is. Nothing calls
  // quitAndInstall on a timer — only an explicit user click
  // (`restartAndInstall` in `updater.ts`) does.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = null

  autoUpdater.on('update-available', (info: { version: string }) => {
    apply({ type: 'update-available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => apply({ type: 'update-not-available' }))
  autoUpdater.on('download-progress', (progress: { percent: number }) => {
    apply({ type: 'download-progress', percent: progress.percent })
  })
  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    apply({ type: 'update-downloaded', version: info.version })
  })
  autoUpdater.on('error', (error: Error) => {
    console.warn('[Phosphor] updater error:', error.message)
    apply({ type: 'error' })
  })
}
