import { describe, expect, it, vi } from 'vitest'
import type { DaemonInstallStatus } from '../daemon/install'
import { installView, logInstallChanges } from './install-status'

describe('installView', () => {
  it('shows nothing before the installer runs, and no paths or machine ids after', () => {
    expect(installView({ state: 'off', detail: 'Windows' })).toBeUndefined()
    expect(installView({ state: 'idle' })).toBeUndefined()
    expect(installView({ state: 'checking' })).toEqual({ state: 'checking' })
    expect(installView({ state: 'installing', step: 'download', version: '0.2.93' })).toEqual({
      state: 'installing',
      step: 'download',
      version: '0.2.93',
    })
    const installed: DaemonInstallStatus = {
      state: 'installed',
      version: '0.2.93',
      program: '/Users/me/.local/lib/phosphor-host/current/bin/phosphor',
      machineId: '00000000-0000-4000-8000-0000000000aa',
      launcher: 'created',
    }
    expect(installView(installed)).toEqual({ state: 'installed', version: '0.2.93' })
  })
  it('keeps the reason a setup is waiting, blocked or failed', () => {
    expect(installView({ state: 'failed', detail: 'pi: env: node' })).toEqual({
      state: 'failed',
      detail: 'pi: env: node',
    })
    expect(
      installView({ state: 'blocked', reason: 'no-pi', detail: 'Install pi to set up.' }),
    ).toEqual({ state: 'blocked', detail: 'Install pi to set up.' })
    expect(
      installView({ state: 'waiting', reason: 'no-v2', detail: 'No release for this Mac yet.' }),
    ).toEqual({ state: 'waiting', detail: 'No release for this Mac yet.' })
  })
})

describe('logInstallChanges', () => {
  it('logs each change once, with the reason and never the machine id', () => {
    const log = vi.fn()
    const changed = logInstallChanges(log)
    changed({ state: 'checking' })
    changed({ state: 'checking' })
    changed({ state: 'failed', detail: 'pi: env: node' })
    changed({
      state: 'installed',
      version: '0.2.93',
      program: '/p',
      machineId: '00000000-0000-4000-8000-0000000000aa',
      launcher: 'created',
    })
    expect(log.mock.calls).toEqual([
      ['service install', { state: 'checking' }],
      ['service install', { state: 'failed', detail: 'pi: env: node' }],
      ['service install', { state: 'installed', version: '0.2.93', launcher: 'created' }],
    ])
  })
})
