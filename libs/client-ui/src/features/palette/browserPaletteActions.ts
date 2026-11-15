import type { HostsSnapshot } from '@shared/ipc'
import type { Navigation } from '@/navigation/Navigation'
import type { Page } from '@/navigation/location'
import { hostPaletteActions } from './hostPaletteActions'
import type { PaletteAction } from './paletteStore'

/** Browser pages use real navigation, never Desktop modal or workspace setters. */
export function browserPaletteActions(
  hosts: HostsSnapshot,
  navigate: Navigation['navigate'],
  addFolder: (hostId: string) => void,
  machine?: string,
): PaletteAction[] {
  const pages: [string, Page][] = [
    ['Machines', 'machines'],
    ['Skills', 'skills'],
    ['Routines', 'routines'],
    ['Artifacts', 'artifacts'],
    ['Settings', 'settings'],
  ]
  return [
    { id: 'home', label: 'Go to Home', run: () => navigate({ to: 'lanes' }) },
    ...pages.map(([label, page]) => ({
      id: `page-${page}`,
      label: `Go to ${label}`,
      run: () =>
        navigate({ to: 'page', page, ...(page !== 'machines' && machine ? { machine } : {}) }),
    })),
    ...Object.entries(hosts).flatMap(([hostId, host]) =>
      hostPaletteActions(hostId, host, addFolder, navigate),
    ),
  ]
}
