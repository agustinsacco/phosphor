import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IDLE, reduceUpdate, type UpdateEvent, type UpdateState } from './update-state'

/**
 * The electron-updater seam: how the CommonJS module is resolved, what a check
 * reports, and how its events reach the `apply` callback. electron-updater is
 * replaced per test so each can choose the module's shape.
 */

const f = vi.hoisted(() => ({
  handlers: new Map<string, (value: unknown) => void>(),
  autoUpdater: {} as Record<string, unknown>,
  check: vi.fn(),
  install: vi.fn(),
}))

type ModuleShape = 'cjs-default' | 'namespace' | 'unloadable'

function mockElectronUpdater(shape: ModuleShape): void {
  vi.doMock('electron-updater', () => {
    if (shape === 'unloadable') throw new Error('Cannot find module electron-updater')
    // Accessing an export a mock does not define throws, so `default` is explicit.
    if (shape === 'namespace') return { default: undefined, autoUpdater: f.autoUpdater }
    return { default: { autoUpdater: f.autoUpdater } }
  })
}

async function loadBackend(shape: ModuleShape = 'cjs-default') {
  mockElectronUpdater(shape)
  return import('./updater-backend')
}

/** Collects every event and folds it through the real reducer. */
function recorder(): {
  apply: (event: UpdateEvent) => void
  events: UpdateEvent[]
  states: UpdateState[]
} {
  const events: UpdateEvent[] = []
  const states: UpdateState[] = []
  let state = IDLE
  return {
    events,
    states,
    apply: (event) => {
      events.push(event)
      state = reduceUpdate(state, event)
      states.push(state)
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  f.handlers.clear()
  f.autoUpdater = {
    on: (event: string, handler: (value: unknown) => void) => f.handlers.set(event, handler),
    checkForUpdates: f.check,
    quitAndInstall: f.install,
  }
  f.check.mockResolvedValue(undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('importUpdater', () => {
  it('resolves autoUpdater from the CommonJS default export', async () => {
    const { importUpdater } = await loadBackend('cjs-default')
    const updater = await importUpdater()
    expect(updater.autoUpdater).toBe(f.autoUpdater)
  })

  it('falls back to the namespace when there is no default export', async () => {
    const { importUpdater } = await loadBackend('namespace')
    const updater = await importUpdater()
    expect(updater.autoUpdater).toBe(f.autoUpdater)
  })
})

describe('checkWithUpdater', () => {
  it('reports the check before asking electron-updater, and nothing else on success', async () => {
    const { checkWithUpdater } = await loadBackend()
    const r = recorder()
    f.check.mockImplementation(async () => {
      expect(r.events).toEqual([{ type: 'check-started' }])
    })
    await checkWithUpdater(r.apply)
    expect(f.check).toHaveBeenCalledTimes(1)
    expect(r.states).toEqual([{ phase: 'checking' }])
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('degrades a failed check or an unloadable module to an error event', async () => {
    f.check.mockRejectedValueOnce(new Error('ENOTFOUND'))
    const failing = recorder()
    await (await loadBackend()).checkWithUpdater(failing.apply)
    expect(failing.events).toEqual([{ type: 'check-started' }, { type: 'error' }])
    expect(failing.states.at(-1)).toEqual(IDLE)

    vi.resetModules()
    const unloadable = recorder()
    await (await loadBackend('unloadable')).checkWithUpdater(unloadable.apply)
    expect(unloadable.events).toEqual([{ type: 'check-started' }, { type: 'error' }])
    expect(console.warn).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenCalledWith('[Phosphor] update check failed:', expect.any(Error))
  })
})

describe('wireUpdaterEvents', () => {
  it('downloads automatically but never installs on quit or by itself', async () => {
    const { wireUpdaterEvents } = await loadBackend()
    const r = recorder()
    await wireUpdaterEvents(r.apply)
    expect(f.autoUpdater).toMatchObject({
      autoDownload: true,
      autoInstallOnAppQuit: false,
      logger: null,
    })
    for (const handler of f.handlers.values()) handler({ version: '2.0.0', percent: 100 })
    expect(f.install).not.toHaveBeenCalled()
    expect(f.check).not.toHaveBeenCalled()
  })

  it('delivers each electron-updater event to apply as a reducer event', async () => {
    const { wireUpdaterEvents } = await loadBackend()
    const r = recorder()
    await wireUpdaterEvents(r.apply)
    expect([...f.handlers.keys()]).toEqual([
      'update-available',
      'update-not-available',
      'download-progress',
      'update-downloaded',
      'error',
    ])
    expect(r.events).toEqual([])

    const emit = (event: string, value?: unknown): void => f.handlers.get(event)!(value)
    emit('update-not-available')
    emit('update-available', { version: '2.0.0' })
    emit('download-progress', { percent: 37.5 })
    emit('error', new Error('socket hang up'))
    emit('update-available', { version: '2.0.0' })
    emit('update-downloaded', { version: '2.0.0' })

    expect(r.events).toEqual([
      { type: 'update-not-available' },
      { type: 'update-available', version: '2.0.0' },
      { type: 'download-progress', percent: 37.5 },
      { type: 'error' },
      { type: 'update-available', version: '2.0.0' },
      { type: 'update-downloaded', version: '2.0.0' },
    ])
    expect(r.states).toEqual([
      IDLE,
      { phase: 'downloading', version: '2.0.0', progressPercent: 0 },
      { phase: 'downloading', version: '2.0.0', progressPercent: 38 },
      IDLE,
      { phase: 'downloading', version: '2.0.0', progressPercent: 0 },
      { phase: 'downloaded', version: '2.0.0' },
    ])
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      '[Phosphor] updater error:',
      'socket hang up',
    )
  })
})
