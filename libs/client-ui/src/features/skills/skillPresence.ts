import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { HostConnectionView } from '@shared/ipc'
import { usePlatform } from '@/platform/Platform'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { useMachinesStore } from '@/stores/machines'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'

/**
 * Which machines already have a global skill of a given name. Each machine's names are read
 * once per connection: This Mac through `pi:commands` (no Skills page registry involved), a
 * Host through `hosts:skills`. A reconnect or capability change reads again; a failed read is
 * retried by the next caller and never kept.
 */
export interface SkillNames {
  status: 'loading' | 'ready' | 'error'
  names: readonly string[]
}
const NO_NAMES: readonly string[] = Object.freeze([])

export const useSkillPresenceStore = create<{ byKey: Record<string, SkillNames> }>(() => ({
  byKey: {},
}))

export function presenceKey(machine: string): string {
  return machine === 'local' ? 'local' : `${machine}:${machineReadGeneration(machine)}`
}

async function readNames(machine: string): Promise<string[]> {
  if (machine === 'local') {
    const { commands, error } = await window.phosphor.invoke('pi:commands')
    if (error) throw new Error(error)
    return commands.flatMap((c) =>
      c.source === 'skill' && c.sourceInfo?.scope === 'user' ? [c.name.replace(/^skill:/, '')] : [],
    )
  }
  return (await window.phosphor.invoke('hosts:skills', machine)).skills.map((s) => s.name)
}

/** Never rejects: the outcome is the store entry. */
export async function loadSkillNames(machine: string, force = false): Promise<void> {
  const key = presenceKey(machine)
  const existing = useSkillPresenceStore.getState().byKey[key]
  if (!force && (existing?.status === 'loading' || existing?.status === 'ready')) return
  const entry: SkillNames = { status: 'loading', names: NO_NAMES }
  const put = (value: SkillNames) =>
    useSkillPresenceStore.setState((s) => ({ byKey: { ...s.byKey, [key]: value } }))
  const current = () => useSkillPresenceStore.getState().byKey[key] === entry
  put(entry)
  try {
    const names = await readNames(machine)
    if (current()) put({ status: 'ready', names })
  } catch {
    if (current()) put({ status: 'error', names: NO_NAMES })
  }
}

export interface ShareMachine {
  /** 'local' or a Host id. */
  id: string
  label: string
  host?: HostConnectionView
  /** Its skills can be listed right now. */
  readable: boolean
}

export const sourceMachine = (workspacePath: string): string =>
  workspacePath.startsWith('host:') ? (workspacePath.slice(5).split('/')[0] ?? '') : 'local'

export const shareMachineLabel = (machine: string): string =>
  machine === 'local' ? 'This Mac' : machineLabel(machine)

/** Every other machine with a Skills page: This Mac where there is one, and Hosts with skills.read. */
export function useShareMachines(source: string): ShareMachine[] {
  const { localLanes } = usePlatform()
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const directory = useMachinesStore((s) => s.machines)
  return useMemo(() => {
    const local: ShareMachine[] = localLanes
      ? [{ id: 'local', label: 'This Mac', readable: true }]
      : []
    const remote = Object.entries(hosts)
      .filter(([, host]) => host.capabilities.includes('skills.read'))
      .map(([id, host]) => ({
        id,
        label: directory.find((machine) => machine.id === id)?.label ?? id,
        host,
        readable: host.state === 'ready',
      }))
    return [...local, ...remote].filter((machine) => machine.id !== source)
  }, [localLanes, hosts, directory, source])
}

export type Presence = 'has' | 'missing' | 'checking' | 'unknown'

/** Per machine id: does it have a global skill called `name`? Loads what it needs. */
export function useSkillPresence(name: string, machines: ShareMachine[]): Record<string, Presence> {
  const byKey = useSkillPresenceStore((s) => s.byKey)
  const readable = useMemo(() => machines.filter((m) => m.readable).map((m) => m.id), [machines])
  // Each readable machine with its connection generation: a reconnect reads again.
  const keys = readable.map(presenceKey).join(' ')
  useEffect(() => {
    for (const id of readable) void loadSkillNames(id)
  }, [keys, readable])
  const presence: Record<string, Presence> = {}
  for (const machine of machines) {
    const entry = machine.readable ? byKey[presenceKey(machine.id)] : undefined
    presence[machine.id] = !machine.readable
      ? 'unknown'
      : !entry || entry.status === 'loading'
        ? 'checking'
        : entry.status === 'error'
          ? 'unknown'
          : entry.names.includes(name)
            ? 'has'
            : 'missing'
  }
  return presence
}
