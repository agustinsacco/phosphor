import { app, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSshInstaller } from '../hosts/ssh-install'
import { log } from '../debug-log'
import { controlClient } from './control-handlers'
import { handle } from './handle'

export function registerSshInstallHandlers(): void {
  const installer = createSshInstaller({
    waitForReady: true,
    verifyEnrollment: async (code, fingerprint) => {
      const result = await controlClient().lookupEnrollment(code)
      return result.ok && result.keyFingerprint === fingerprint
    },
    installer: () =>
      readFile(
        app.isPackaged
          ? join(process.resourcesPath, 'host-install.sh')
          : join(app.getAppPath(), '../../tools/host-release/install.sh'),
        'utf8',
      ),
    log: (step, exitCode, reason) => log('ssh-install', step, { exitCode, reason }),
  })
  ipcMain.on('hosts:sshInstallReady', (event, jobId: unknown) =>
    installer.ready(jobId, event.sender.id),
  )
  app.once('will-quit', () => installer.stop())
  const owners = new WeakSet<Electron.WebContents>()
  handle('hosts:sshInstall', (event, target, repository = '') => {
    const sender = event.sender
    const result = installer.start(target, repository, sender.id, (state) => {
      if (!sender.isDestroyed()) sender.send(`hosts:sshInstall:${result.jobId}`, state)
    })
    if (!owners.has(sender)) {
      owners.add(sender)
      sender.once('destroyed', () => installer.cancelOwner(sender.id))
    }
    return result
  })
  handle('hosts:sshInstallCancel', (event, jobId) => installer.cancel(jobId, event.sender.id))
}
