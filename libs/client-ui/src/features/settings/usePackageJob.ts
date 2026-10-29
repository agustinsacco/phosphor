import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from '@shared/errors'

export interface PackageJobState {
  running: boolean
  output: string
  exitCode: number | null
}

/**
 * Drive one streamed package job (pi install/remove/update, or the pi
 * self-install) at a time: start() invokes a channel that returns a jobId,
 * output accumulates from `packages:output:<jobId>`, and the exit code
 * arrives on `packages:exit:<jobId>`. The latest start() is the one heard.
 */
export function usePackageJob(onExit?: (exitCode: number) => void): PackageJobState & {
  start: (begin: () => Promise<{ jobId: string }>) => Promise<void>
  reset: () => void
} {
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState('')
  const [exitCode, setExitCode] = useState<number | null>(null)
  // Ref so the exit listener sees the latest callback without resubscribing.
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  /** Counts starts; a start whose count is no longer the latest stays unheard. */
  const latest = useRef(0)
  const stopListening = useRef<(() => void) | null>(null)

  const stop = useCallback((): void => {
    stopListening.current?.()
    stopListening.current = null
  }, [])

  // Unmounting stops listening, and so does a start still waiting for its id.
  useEffect(
    () => () => {
      latest.current += 1
      stop()
    },
    [stop],
  )

  const start = useCallback(
    async (begin: () => Promise<{ jobId: string }>): Promise<void> => {
      const mine = ++latest.current
      stop()
      setOutput('')
      setExitCode(null)
      setRunning(true)
      try {
        const { jobId } = await begin()
        if (mine !== latest.current) return
        // Listen now, not after the next render: main sends a fast job's output
        // and exit right behind the reply naming it, and drops what nobody hears.
        const offOutput = window.phosphor.onPackagesJobOutput(jobId, (data) => {
          setOutput((prev) => prev + data)
        })
        const offExit = window.phosphor.onPackagesJobExit(jobId, (code) => {
          setRunning(false)
          setExitCode(code)
          onExitRef.current?.(code)
        })
        stopListening.current = () => {
          offOutput()
          offExit()
        }
      } catch (err) {
        if (mine !== latest.current) return
        setRunning(false)
        setExitCode(127)
        setOutput(errorText(err))
      }
    },
    [stop],
  )

  const reset = useCallback(() => {
    stop()
    setOutput('')
    setExitCode(null)
    setRunning(false)
  }, [stop])

  return { running, output, exitCode, start, reset }
}
