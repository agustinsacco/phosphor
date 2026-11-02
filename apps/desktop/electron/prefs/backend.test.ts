import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFS } from '@shared/models'

const state = vi.hoisted(() => ({
  seed: {} as Record<string, unknown>,
  stores: [] as { name?: string; data: Record<string, unknown> }[],
  deleted: [] as string[],
}))
vi.mock('electron-store', () => ({
  default: class {
    private data: Record<string, unknown>
    constructor(options: { defaults: Record<string, unknown>; name?: string }) {
      this.data = structuredClone(options.defaults)
      if (!options.name) Object.assign(this.data, state.seed)
      state.stores.push({ name: options.name, data: this.data })
    }
    get(key: string): unknown {
      return this.data[key]
    }
    set(key: string, value: unknown): void {
      this.data[key] = value
    }
    delete(key: string): void {
      state.deleted.push(key)
      delete this.data[key]
    }
  },
}))

beforeEach(() => {
  vi.resetModules()
  state.seed = {}
  state.stores = []
  state.deleted = []
})

describe('preference backend', () => {
  it('opens each store independently and lazily, including remote-first access', async () => {
    const backend = await import('./backend')
    expect(state.stores).toEqual([])
    expect(backend.getRemoteClients()).toEqual({})
    backend.getRemoteClients()
    expect(state.stores.map(({ name }) => name)).toEqual(['remote-clients'])
    const prefs = backend.prefs()
    expect(backend.prefs()).toBe(prefs)
    expect(state.stores.map(({ name }) => name)).toEqual(['remote-clients', undefined])
    expect(state.stores[1]?.data).toEqual(DEFAULT_APP_PREFS)
  })

  it('migrates defaults once and removes retired preview switches only from app prefs', async () => {
    state.seed = { claudeAutocompact: ' 100k ', accountPreview: true, machinesPreview: true }
    const backend = await import('./backend')
    expect(backend.prefs().get('contextBudget')).toBe('100k')
    expect(state.deleted).toEqual(['claudeAutocompact', 'accountPreview', 'machinesPreview'])
    expect(state.stores[0]?.data).not.toHaveProperty('claudeAutocompact')
    expect(state.stores[0]?.data).not.toHaveProperty('accountPreview')
    expect(state.stores[0]?.data).not.toHaveProperty('machinesPreview')
    backend.prefs()
    backend.getRemoteClients()
    expect(state.deleted).toEqual(['claudeAutocompact', 'accountPreview', 'machinesPreview'])
  })

  it('preserves an explicit context budget over a legacy value', async () => {
    state.seed = { claudeAutocompact: '100k', contextBudget: '150k' }
    const { prefs } = await import('./backend')
    expect(prefs().get('contextBudget')).toBe('150k')
    expect(state.stores[0]?.data).not.toHaveProperty('claudeAutocompact')
  })

  it('cleans remote identities on read and write without putting them in app prefs', async () => {
    const backend = await import('./backend')
    const user = randomUUID()
    const clientId = randomUUID()
    backend.setRemoteClients({
      [user]: { clientId, label: 'Viewer' },
      invalid: { clientId, label: 'Viewer' },
    })
    expect(backend.getRemoteClients()).toEqual({ [user]: { clientId, label: 'Viewer' } })
    expect(state.stores[0]?.data.remoteClients).toEqual({ [user]: { clientId, label: 'Viewer' } })
    const raw = state.stores[0]!.data
    raw.remoteClients = { invalid: { clientId, label: 'Viewer' } }
    expect(backend.getRemoteClients()).toEqual({})
    backend.prefs()
    expect(state.stores[1]?.data).not.toHaveProperty('remoteClients')
    expect(JSON.stringify(state.stores[1]?.data)).not.toContain(user)
  })

  it('keeps remembered settings access cleaned and main-only beside remote identities', async () => {
    const backend = await import('./backend')
    const user = randomUUID()
    const host = randomUUID()
    expect(backend.getConfigureHosts()).toEqual({})
    backend.setConfigureHosts({ [user]: [host, 'bad'], invalid: [host] })
    expect(backend.getConfigureHosts()).toEqual({ [user]: [host] })
    expect(state.stores.map(({ name }) => name)).toEqual(['remote-clients'])
    state.stores[0]!.data.configureHosts = { [user]: 'not-a-list' }
    expect(backend.getConfigureHosts()).toEqual({})
    backend.prefs()
    expect(JSON.stringify(state.stores[1]?.data)).not.toContain(host)
  })
})
