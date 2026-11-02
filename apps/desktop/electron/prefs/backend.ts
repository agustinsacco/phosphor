import Store from 'electron-store'
import { DEFAULT_APP_PREFS, type AppPrefs } from '@shared/models'
import { cleanClients, type RemoteClients } from '../hosts/client-id'
import { cleanConfigureHosts, type ConfigureHosts } from '../hosts/configure-hosts'
import { migrateRenamedPrefs, type RawPrefs } from '../prefs-migrations'

export type PrefsGetter = () => Store<AppPrefs>

/**
 * Constructed lazily, NOT at module scope.
 *
 * electron-store resolves `userData` the moment it is instantiated, and ES
 * imports are hoisted — a module-scope `new Store()` would run while main.ts
 * is still importing, i.e. before main.ts can redirect userData for E2E runs.
 * That leaked test workspaces into the developer's real prefs. Deferring the
 * construction to first use keeps the redirect effective.
 */
let store: Store<AppPrefs> | null = null

export function prefs(): Store<AppPrefs> {
  if (!store) {
    store = new Store<AppPrefs>({ defaults: DEFAULT_APP_PREFS })
    migrateRenamedPrefs(store as unknown as RawPrefs)
    // Retired switches are ignored and removed, not migrated into account state.
    const raw = store as unknown as RawPrefs
    raw.delete('accountPreview')
    raw.delete('machinesPreview')
  }
  return store
}

// Separate main-only store: account ids must not enter renderer preferences.
type RemotePrefs = { remoteClients: RemoteClients; configureHosts: ConfigureHosts }
let remoteStore: Store<RemotePrefs> | null = null
function remotePrefs() {
  remoteStore ??= new Store<RemotePrefs>({
    name: 'remote-clients',
    defaults: { remoteClients: {}, configureHosts: {} },
  })
  return remoteStore
}
export const getRemoteClients = (): RemoteClients =>
  cleanClients(remotePrefs().get('remoteClients'))
export const setRemoteClients = (clients: RemoteClients): void =>
  remotePrefs().set('remoteClients', cleanClients(clients))
export const getConfigureHosts = (): ConfigureHosts =>
  cleanConfigureHosts(remotePrefs().get('configureHosts'))
export const setConfigureHosts = (hosts: ConfigureHosts): void =>
  remotePrefs().set('configureHosts', cleanConfigureHosts(hosts))
