import { app, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import { piStubPath } from '../pi/stub'

let tray: Tray | undefined
let enabled = false
let open: () => void = () => {}
let pause: () => void = () => {}

export function installRoutineBackground(onOpen: () => void, onPause: () => void): void {
  open = onOpen
  pause = onPause
}

export function routinesKeepRunning(): boolean {
  return enabled
}

/** Opt-in, visible background operation; quitting still stops every local run. */
export function configureRoutineBackground(value: boolean): void {
  if (value && !tray && !piStubPath()) {
    const path = app.isPackaged
      ? join(process.resourcesPath, 'routine-tray.png')
      : join(app.getAppPath(), 'build/icons/32x32.png')
    const image = nativeImage.createFromPath(path).resize({ width: 18, height: 18 })
    if (image.isEmpty()) throw new Error('Could not load the background tray icon.')
    tray = new Tray(image)
    tray.setToolTip('Phosphor · local routines run while this computer is awake')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Phosphor', click: () => open() },
        { label: 'Pause all routines', click: () => pause() },
        { type: 'separator' },
        { label: 'Quit Phosphor (stops local routines)', click: () => app.quit() },
      ]),
    )
    tray.on('click', () => open())
  }
  if (!value) {
    tray?.destroy()
    tray = undefined
  }
  enabled = value
}
