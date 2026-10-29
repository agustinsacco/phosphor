export const LANE_PANES = [
  'chat',
  'files',
  'changes',
  'artifacts',
  'subagents',
  'terminal',
] as const
export type LanePane = (typeof LANE_PANES)[number]
export const PAGES = ['machines', 'routines', 'skills', 'artifacts', 'settings'] as const
export type Page = (typeof PAGES)[number]
export type LaneKey = { hostId: string; laneId: string } | { sessionId: string }
export type Location =
  | { to: 'lanes' | 'new'; machine?: string }
  | { to: 'lane'; lane: LaneKey; pane?: LanePane }
  | { to: 'page'; page: Page; machine?: string }
  | { to: 'unavailable' }

export function locationMachine(location: Location): string | undefined {
  return location.to === 'lane' && 'hostId' in location.lane
    ? location.lane.hostId
    : 'machine' in location
      ? location.machine
      : undefined
}

function id(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const decoded = decodeURIComponent(value)
    return /^[a-zA-Z0-9_-]{1,256}$/.test(decoded) ? decoded : undefined
  } catch {
    return undefined
  }
}

/** URLs contain opaque Host/lane IDs only, never workspace or session-file paths. */
export function decodeLocation(pathname: string): Location {
  if (pathname === '/') return { to: 'new' }
  if (pathname === '/lanes') return { to: 'lanes' }
  const parts = pathname.split('/').slice(1)
  if (parts[0] === 'lanes' && parts.length >= 3 && parts.length <= 4) {
    const hostId = id(parts[1])
    const laneId = id(parts[2])
    const pane = parts[3] ?? 'chat'
    if (hostId && laneId && LANE_PANES.includes(pane as LanePane))
      return { to: 'lane', lane: { hostId, laneId }, pane: pane as LanePane }
  }
  // The browser once had an Inbox. Neither client has one, so an old link opens the lane list.
  const list = parts[0] === 'inbox' ? 'lanes' : parts[0]
  if ((list === 'lanes' || list === 'new') && parts.length <= 2) {
    const machine = id(parts[1])
    if (parts.length === 1 || machine) return { to: list, ...(machine ? { machine } : {}) }
  }
  if (parts[0] === 'pages' && PAGES.includes(parts[1] as Page) && parts.length <= 3) {
    const machine = id(parts[2])
    if (parts.length === 2 || machine)
      return { to: 'page', page: parts[1] as Page, ...(machine ? { machine } : {}) }
  }
  return { to: 'unavailable' }
}

export function encodeLocation(location: Location): string {
  const encode = (value: string): string => {
    if (id(encodeURIComponent(value)) !== value) throw new Error('Invalid navigation ID')
    return encodeURIComponent(value)
  }
  if (location.to === 'lane') {
    if (!('hostId' in location.lane)) throw new Error('Local lanes have no browser URL')
    return `/lanes/${encode(location.lane.hostId)}/${encode(location.lane.laneId)}/${location.pane ?? 'chat'}`
  }
  if (location.to === 'unavailable') return '/unavailable'
  const suffix = location.machine ? `/${encode(location.machine)}` : ''
  return location.to === 'page' ? `/pages/${location.page}${suffix}` : `/${location.to}${suffix}`
}
