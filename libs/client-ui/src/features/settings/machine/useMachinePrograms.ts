import type { MachineView } from '@shared/control-api'
import type { ProviderLoginOp } from '@shared/host-protocol-providers'
import type { MachineTaskOp } from '@shared/machine-settings'
import { errorText } from '@shared/errors'
import { useEffect, useRef, useState } from 'react'

import { loginHostProgram, runHostTask } from './machineProgramActions'
import type { HostSettingsState } from './useHostSettings'

/** A Host section's way to run a private program (sign-in) or a reviewed task on that Host. */
export interface MachinePrograms {
  login(provider: string, account?: Pick<ProviderLoginOp, 'accountId' | 'addAccount'>): void
  task(op: Omit<MachineTaskOp, 'type'>): void
  /** Opens a task the caller has confirmed; resolves to its program id, or null when none opened. */
  openTask(
    op: Omit<MachineTaskOp, 'type'>,
    title: string,
    instructions: string,
  ): Promise<string | null>
  busy: boolean
  available: boolean
}
export function useMachinePrograms(
  machine: Pick<MachineView, 'id' | 'label'>,
  settings: HostSettingsState,
) {
  const { allowed, connection } = settings
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [program, setProgram] = useState<{
    ptyId: string
    title: string
    instructions: string
  } | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!allowed) setProgram(null)
  }, [allowed])
  const { data, loading, refresh } = settings
  const authenticating = data?.providers?.authenticating
  useEffect(() => {
    if (!authenticating || loading) return
    const timer = setTimeout(() => void refresh(), 1500)
    return () => clearTimeout(timer)
  }, [authenticating, data, loading, refresh])
  /** The link offers private Host programs; running one also needs the grant. */
  const terminalLink =
    connection?.capabilities.includes('terminal') === true &&
    connection.capabilities.includes('sessions.control')
  const terminals = allowed && terminalLink
  async function openProgram(
    start: () => Promise<{ ptyId: string }>,
    title: string,
    instructions: string,
  ): Promise<string | null> {
    if (!alive.current || !terminals || starting || program) return null
    setStarting(true)
    setError(null)
    try {
      const result = await start()
      if (alive.current) {
        setProgram({ ...result, title, instructions })
        return result.ptyId
      }
      void window.phosphor.invoke('pty:kill', result.ptyId).catch(() => {})
    } catch (e) {
      if (alive.current) setError(errorText(e))
    } finally {
      if (alive.current) setStarting(false)
    }
    return null
  }
  const programs: MachinePrograms = {
    login: (provider, account) =>
      void loginHostProgram(machine, settings, openProgram, provider, account),
    task: (input) => void runHostTask(machine, alive, openProgram, input),
    openTask: (op, title, instructions) =>
      openProgram(
        () =>
          window.phosphor.invoke('hosts:machineTask', machine.id, { type: 'machine.task', ...op }),
        title,
        instructions,
      ),
    busy: starting || !!program,
    available: terminals,
  }
  return {
    error,
    setError,
    starting,
    program,
    setProgram,
    alive,
    terminalLink,
    terminals,
    programs,
  }
}
