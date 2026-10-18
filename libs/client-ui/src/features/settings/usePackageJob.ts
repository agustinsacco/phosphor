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
 * arrives on `packages:exit:<jobId>`.
 */
export function usePackageJob(onExit?: (exitCode: number) => void): PackageJobState & {
  start: (begin: () => Promise<{ jobId: string }>) => Promise<void>
  reset: () => void
} {
  const [jobId, setJobId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState('')
  const [exitCode, setExitCode] = useState<number | null>(null)
  // Ref so the exit listener sees the latest callback without resubscribing.
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  useEffect(() => {
    if (!jobId) return
    const offOutput = window.phosphor.onPackagesJobOutput(jobId, (data) => {
      setOutput((prev) => prev + data)
    })
    const offExit = window.phosphor.onPackagesJobExit(jobId, (code) => {
      setRunning(false)
      setExitCode(code)
      onExitRef.current?.(code)
    })
    return () => {
      offOutput()
      offExit()
    }
  }, [jobId])

  const start = useCallback(async (begin: () => Promise<{ jobId: string }>): Promise<void> => {
    setOutput('')
    setExitCode(null)
    setRunning(true)
    try {
      const { jobId: nextJobId } = await begin()
      setJobId(nextJobId)
    } catch (err) {
      setRunning(false)
      setExitCode(127)
      setOutput(errorText(err))
    }
  }, [])

  const reset = useCallback(() => {
    setJobId(null)
    setOutput('')
    setExitCode(null)
    setRunning(false)
  }, [])

  return { running, output, exitCode, start, reset }
}
