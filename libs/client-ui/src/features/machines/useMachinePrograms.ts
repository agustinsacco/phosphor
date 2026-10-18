import type { MachineView } from '@shared/control-api'
import { errorText } from '@shared/errors'
import { useEffect, useRef, useState } from 'react'
import type { MachinePrograms } from './MachineProviderSettings'

import { loginHostProgram, runHostTask } from './machineProgramActions'
import type { HostSettingsState } from './useHostSettings'
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
  const terminals =
    allowed &&
    connection?.capabilities.includes('terminal') === true &&
    connection.capabilities.includes('sessions.control')
  async function openProgram(
    start: () => Promise<{ ptyId: string }>,
    title: string,
    instructions: string,
  ) {
    if (!alive.current || !terminals || starting || program) return
    setStarting(true)
    setError(null)
    try {
      const result = await start()
      if (alive.current) setProgram({ ...result, title, instructions })
      else void window.phosphor.invoke('pty:kill', result.ptyId).catch(() => {})
    } catch (e) {
      if (alive.current) setError(errorText(e))
    } finally {
      if (alive.current) setStarting(false)
    }
  }
  const programs: MachinePrograms = {
    login: (provider, account) =>
      void loginHostProgram(machine, settings, openProgram, provider, account),
    task: (input) => void runHostTask(machine, alive, openProgram, input),
    busy: starting || !!program,
    available: terminals,
  }
  return { error, setError, starting, program, setProgram, alive, terminals, programs }
}
