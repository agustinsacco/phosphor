import type { LaneSearchFields } from '@/features/sessions/laneSearch'

/**
 * Made-up machines for the Machines preview (Settings → Advanced → Machines).
 *
 * The preview tries the machine-aware sidebar and the Machines page before
 * Phosphor can reach a Host (component 21), so bee1 and bee2 and their lanes
 * are fixed data here: nothing connects anywhere. This computer is never in
 * this file; its rows and its machine page use real data.
 */

/** The filter and chip id of this computer. */
export const LOCAL_MACHINE = 'local'

export type RemoteLaneState = 'running' | 'waiting' | 'idle' | 'done'

export interface FakeDependency {
  name: string
  version: string
  /** What it unlocks, or why it is missing. */
  note: string
  ok: boolean
  upgrade?: string
}

export interface FakeMachine {
  id: string
  name: string
  up: boolean
  /** Minutes since the machine was last heard from. */
  seenMinutesAgo: number
  platform: string
  hostVersion: string
  hostUpdate?: string
  dependencies: FakeDependency[]
  logins: { name: string; signedIn: boolean }[]
}

export interface RemoteLane {
  id: string
  machineId: string
  /**
   * The project, by folder name. The real thing matches a project across
   * machines by its git remote; the preview has no remote to read, so the
   * name stands in.
   */
  project: string
  title: string
  branch: string
  pr?: number
  state: RemoteLaneState
  minutesAgo: number
}

export const FAKE_MACHINES: readonly FakeMachine[] = [
  {
    id: 'bee1',
    name: 'bee1',
    up: true,
    seenMinutesAgo: 0.2,
    platform: 'Linux x64',
    hostVersion: '0.2.0',
    hostUpdate: '0.2.1',
    dependencies: [
      { name: 'pi', version: '0.87.1', note: 'runs lanes', ok: true, upgrade: '0.88.0' },
      { name: 'pi-claude-cli', version: '0.10.0', note: 'runs Claude lanes', ok: true },
      { name: 'Claude Code', version: '2.1.283', note: 'logged in', ok: true, upgrade: '2.1.290' },
      { name: 'Tailscale', version: '1.102.2', note: 'HTTPS ready', ok: true },
    ],
    logins: [
      { name: 'ChatGPT (Codex)', signedIn: true },
      { name: 'Claude Pro/Max', signedIn: false },
      { name: 'xAI', signedIn: false },
    ],
  },
  {
    id: 'bee2',
    name: 'bee2',
    up: false,
    seenMinutesAgo: 190,
    platform: 'Linux x64',
    hostVersion: '0.2.0',
    dependencies: [
      { name: 'pi', version: '0.86.0', note: 'runs lanes', ok: true, upgrade: '0.88.0' },
      { name: 'pi-claude-cli', version: '', note: 'not installed: no Claude lanes', ok: false },
      { name: 'Tailscale', version: '1.102.2', note: 'HTTPS ready', ok: true },
    ],
    logins: [{ name: 'ChatGPT (Codex)', signedIn: true }],
  },
]

export const FAKE_LANES: readonly RemoteLane[] = [
  {
    id: 'bee1-bundle',
    machineId: 'bee1',
    project: 'phosphor',
    title: 'Host bundle on Linux',
    branch: 'agustin/host-bundle',
    pr: 403,
    state: 'running',
    minutesAgo: 2,
  },
  {
    id: 'bee1-login',
    machineId: 'bee1',
    project: 'phosphor',
    title: 'Provider login on a Host',
    branch: 'agustin/host-provider-login',
    pr: 420,
    state: 'waiting',
    minutesAgo: 9,
  },
  {
    id: 'bee1-rates',
    machineId: 'bee1',
    project: 'brigades',
    title: 'Fix rate import',
    branch: 'agustin/rate-import',
    state: 'idle',
    minutesAgo: 50,
  },
  {
    id: 'bee2-e2e',
    machineId: 'bee2',
    project: 'phosphor',
    title: 'Login e2e on Linux',
    branch: 'agustin/login-e2e',
    pr: 405,
    state: 'idle',
    minutesAgo: 190,
  },
]

/** What the sidebar's lane search matches on a remote lane: title, branch and PR, as for a local one. */
export function remoteLaneFields(lane: RemoteLane): LaneSearchFields {
  return {
    title: lane.title,
    branch: lane.branch,
    pr: lane.pr === undefined ? undefined : { number: lane.pr, title: '' },
  }
}

export function machineById(id: string): FakeMachine | undefined {
  return FAKE_MACHINES.find((machine) => machine.id === id)
}

/** Whether this computer's own lanes show under a filter. */
export function showsLocal(filter: string): boolean {
  return filter === 'all' || filter === LOCAL_MACHINE
}

export function lanesOnFilter(lanes: readonly RemoteLane[], filter: string): RemoteLane[] {
  return lanes.filter((lane) => filter === 'all' || lane.machineId === filter)
}

function sameProject(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export function lanesForProject(lanes: readonly RemoteLane[], project: string): RemoteLane[] {
  return lanes.filter((lane) => sameProject(lane.project, project))
}

/** Projects that have lanes only on other machines, in the order their lanes come. */
export function remoteOnlyProjects(
  lanes: readonly RemoteLane[],
  localProjects: readonly string[],
): { name: string; lanes: RemoteLane[] }[] {
  const projects: { name: string; lanes: RemoteLane[] }[] = []
  for (const lane of lanes) {
    if (localProjects.some((name) => sameProject(name, lane.project))) continue
    const known = projects.find((project) => sameProject(project.name, lane.project))
    if (known) known.lanes.push(lane)
    else projects.push({ name: lane.project, lanes: [lane] })
  }
  return projects
}

/** "12 s", "9 min", "3 h". */
export function ago(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)} s`
  if (minutes < 60) return `${Math.round(minutes)} min`
  return `${Math.floor(minutes / 60)} h`
}

/** "up · seen 12 s ago" or "down 3 h". */
export function machineStatus(machine: FakeMachine): string {
  return machine.up
    ? `up · seen ${ago(machine.seenMinutesAgo)} ago`
    : `down ${ago(machine.seenMinutesAgo)}`
}

export const LANE_STATE_LABEL: Record<RemoteLaneState, string> = {
  running: 'Working',
  waiting: 'Needs you',
  idle: 'Idle',
  done: 'Finished',
}

/** Lanes still going: what a machine row counts and the finish demo picks from. */
export function isLive(lane: RemoteLane): boolean {
  return lane.state === 'running' || lane.state === 'waiting'
}

/** The lane the finish demo ends next: the first live one on a machine that is up. */
export function nextToFinish(lanes: readonly RemoteLane[]): RemoteLane | undefined {
  return lanes.find((lane) => isLive(lane) && machineById(lane.machineId)?.up === true)
}

export function finishLane(lanes: readonly RemoteLane[], id: string): RemoteLane[] {
  return lanes.map((lane) => (lane.id === id ? { ...lane, state: 'done', minutesAgo: 0 } : lane))
}

/** What this computer is called: in the filter, and on its own lane rows. */
export function localMachineName(platform: string): { long: string; short: string } {
  return platform === 'darwin'
    ? { long: 'This Mac', short: 'Mac' }
    : { long: 'This computer', short: 'Local' }
}
