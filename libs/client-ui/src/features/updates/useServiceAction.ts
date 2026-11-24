import { useEffect, useRef, useState } from 'react'
import type { LocalMachineAction, LocalMachineStatus } from '@phosphor/shared/ipc'
import { useOpAction } from '@/features/agent-control/useOpRead'
import { promptChoice } from '@/stores/prompt'

export function laneCount(count: number | undefined) {
  return count === undefined
    ? 'Working-lane count unavailable'
    : `${count} working ${count === 1 ? 'lane' : 'lanes'}`
}

/** Started is an acknowledgement, not the final result. The version after the pause is evidence. */
export function useServiceAction(
  status: LocalMachineStatus | undefined,
  working: number | undefined,
  reload: () => void,
) {
  const [message, setMessage] = useState('')
  const [started, setStarted] = useState<{ version?: string; sawPause: boolean; text: string }>()
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const action = useOpAction()
  const ready = status?.service === 'ready'
  const paused = !!status?.pause && status.pause.kind !== 'none'
  const version = status?.serviceVersion
  useEffect(() => {
    if (!ready || !started) return
    if (version && version !== started.version) setStarted(undefined)
    else if (paused && !started.sawPause) setStarted({ ...started, sawPause: true })
  }, [started, ready, version, paused])
  const failed = !!(ready && !paused && started?.sawPause && version && version === started.version)
  const updateText = failed
    ? `The update didn't finish. The Phosphor service is still on ${version}.`
    : ready && !paused && started?.text
  async function run(name: LocalMachineAction) {
    setMessage('')
    if (
      name === 'update-service' &&
      (await promptChoice({
        title: 'Update Phosphor service?',
        message: `${laneCount(working)}. The update waits for turns, sub-agents and routines before restarting. Sub-agent work in older lanes may be interrupted.`,
        choices: [{ label: 'Update service', value: 'update', primary: true }],
      })) !== 'update'
    )
      return
    if (!alive.current) return
    const result = await window.phosphor.invoke('app:localMachineAction', name)
    if (!alive.current) return
    if (result.ok && name === 'update-service')
      setStarted({ version, sawPause: false, text: result.message ?? 'Update started.' })
    else setMessage(result.message ?? (result.ok ? 'Done.' : 'The service refused the action.'))
    reload()
  }
  return {
    ...action,
    invoke: (name: LocalMachineAction) => action.run(() => run(name)),
    failed,
    message: failed ? updateText : action.error || message || updateText,
  }
}
