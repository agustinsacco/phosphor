import { writeFile } from 'node:fs/promises'
import { app, dialog } from 'electron'
import { startInstalledService } from '@phosphor/session-runtime/host-install/start-service'
import type { LocalMachineStatus } from '@shared/ipc'
import { shutdownApproval } from '../shutdown-approval'

export async function startService() {
  if (!app.isPackaged)
    return { ok: false, message: 'Development builds cannot start the Phosphor service.' }
  await startInstalledService(process.platform, process.getuid?.())
  return { ok: true, message: 'Asked the Phosphor service to start.' }
}

export async function restartToFinish() {
  if (!(await shutdownApproval.request('quit'))) return { ok: false, message: 'Restart cancelled.' }
  app.relaunch()
  app.quit()
  return { ok: true }
}

// Only categorical status fields. Never copy the journal, log, environment or host projection.
export async function exportServiceDiagnostics(status: LocalMachineStatus) {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export Phosphor service diagnostics',
    defaultPath: 'phosphor-service-status.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (canceled || !filePath) return { ok: false, message: 'Export cancelled.' }
  const { mode, migration, step, failure, service, serviceVersion, pause } = status
  const report = {
    appVersion: app.getVersion(),
    os: process.platform,
    mode,
    migration,
    step,
    failure: failure && { step: failure.step, code: failure.code },
    service,
    serviceVersion,
    pause: pause?.kind,
  }
  await writeFile(filePath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  return { ok: true, message: 'Exported service diagnostics.' }
}
