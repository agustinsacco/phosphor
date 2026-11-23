import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { exportServiceDiagnostics, restartToFinish, startService } from './local-service-actions'

const h = vi.hoisted(() => ({
  app: { isPackaged: false, getVersion: () => '1.0.0', relaunch: vi.fn(), quit: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  start: vi.fn(),
  approval: vi.fn(),
}))
vi.mock('electron', () => h)
vi.mock('../shutdown-approval', () => ({ shutdownApproval: { request: h.approval } }))
vi.mock('@phosphor/session-runtime/host-install/start-service', () => ({
  startInstalledService: h.start,
}))
it('cannot start an OS service from an unpackaged build', async () => {
  expect((await startService()).ok).toBe(false)
  expect(h.start).not.toHaveBeenCalled()
})
it('only relaunches Desktop when quitting was approved', async () => {
  h.approval.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  expect((await restartToFinish()).ok).toBe(false)
  expect(h.app.relaunch).not.toHaveBeenCalled()
  expect((await restartToFinish()).ok).toBe(true)
  expect(h.approval.mock.calls).toEqual([['quit'], ['quit']])
  expect(h.app.quit).toHaveBeenCalledOnce()
})
it('exports only status fields to the selected file, without copying unknown diagnostic details', async () => {
  const root = await mkdtemp(join(tmpdir(), 'service-status-'))
  try {
    const filePath = join(root, 'report.json')
    h.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath })
    const failure = { step: 'verify', code: 'mismatch', detail: 'private detail' }
    const status = {
      mode: 'in-app',
      migration: 'failed',
      failure,
      privateData: 'not for export',
    } as const
    expect((await exportServiceDiagnostics(status)).ok).toBe(true)
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      mode: 'in-app',
      migration: 'failed',
      failure: { step: 'verify', code: 'mismatch' },
      appVersion: '1.0.0',
      os: process.platform,
    })
    h.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: true,
      filePath: join(root, 'cancelled'),
    })
    expect((await exportServiceDiagnostics(status)).ok).toBe(false)
    await expect(readFile(join(root, 'cancelled'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
