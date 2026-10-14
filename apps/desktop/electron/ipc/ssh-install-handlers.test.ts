import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  read: vi.fn(async () => 'bundled signed script'),
  lookup: vi.fn(),
  handle: vi.fn(),
  on: vi.fn(),
  log: vi.fn(),
  app: { isPackaged: false, getAppPath: () => '/project/apps/desktop', once: vi.fn() },
}))
vi.mock('electron', () => ({ app: mocks.app, ipcMain: { on: mocks.on } }))
vi.mock('node:fs/promises', () => ({ readFile: mocks.read }))
vi.mock('../hosts/ssh-install', () => ({ createSshInstaller: mocks.create }))
vi.mock('../debug-log', () => ({ log: mocks.log }))
vi.mock('./control-handlers', () => ({ controlClient: () => ({ lookupEnrollment: mocks.lookup }) }))
vi.mock('./handle', () => ({ handle: mocks.handle }))
import { registerSshInstallHandlers } from './ssh-install-handlers'
import type { createSshInstaller } from '../hosts/ssh-install'
type Ports = Parameters<typeof createSshInstaller>[0]
let ports: Ports
beforeEach(() => {
  vi.clearAllMocks()
  mocks.app.isPackaged = false
  mocks.create.mockImplementation((value: Ports) => {
    ports = value
    return { start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), ready: vi.fn() }
  })
  registerSshInstallHandlers()
})
it('looks up the parsed enrollment and refuses mismatch or control failure', async () => {
  mocks.lookup.mockResolvedValue({ ok: true, keyFingerprint: 'abcd-1234-5678-90ef' })
  expect(await ports.verifyEnrollment('BCDFGHJK', 'abcd-1234-5678-90ef')).toBe(true)
  expect(mocks.lookup).toHaveBeenCalledWith('BCDFGHJK')
  expect(await ports.verifyEnrollment('BCDFGHJK', '0000-0000-0000-0000')).toBe(false)
  mocks.lookup.mockResolvedValue({ ok: false, error: { code: 'expired' } })
  expect(await ports.verifyEnrollment('BCDFGHJK', 'abcd-1234-5678-90ef')).toBe(false)
})
it('reads the committed installer in development, waits for subscription and logs only fixed fields', async () => {
  expect(await ports.installer()).toBe('bundled signed script')
  expect(mocks.read).toHaveBeenCalledWith('/project/tools/host-release/install.sh', 'utf8')
  expect(ports.waitForReady).toBe(true)
  ports.log('login', 0, 'ok')
  expect(mocks.log).toHaveBeenCalledWith('ssh-install', 'login', { exitCode: 0, reason: 'ok' })
  expect(mocks.handle.mock.calls.map(([channel]) => channel)).toEqual([
    'hosts:sshInstall',
    'hosts:sshInstallCancel',
  ])
})
