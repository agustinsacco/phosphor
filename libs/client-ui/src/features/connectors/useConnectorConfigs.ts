import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpConfigsResult } from '@shared/mcp'
import type { PiPackageEntry } from '@shared/models'
import { errorText } from '@shared/errors'

interface Loaded {
  workspacePath: string | undefined
  configs: McpConfigsResult
  packages: PiPackageEntry[]
}

export function useConnectorConfigs(workspacePath: string | undefined) {
  const [loaded, setLoaded] = useState<Loaded>()
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const epoch = ++generation.current
    try {
      const [configs, packages] = await Promise.all([
        window.phosphor.invoke('mcp:readConfigs', workspacePath),
        window.phosphor.invoke('packages:list', workspacePath),
      ])
      if (epoch !== generation.current) return
      const next = { workspacePath, configs, packages }
      setLoaded((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
      setError(null)
    } catch (err) {
      if (epoch === generation.current) setError(errorText(err))
    }
  }, [workspacePath])
  useEffect(() => {
    const requests = generation
    void refresh()
    const focused = () => {
      if (document.visibilityState !== 'hidden') void refresh()
    }
    window.addEventListener('focus', focused)
    const timer = window.setInterval(focused, 15_000)
    return () => {
      requests.current++
      clearInterval(timer)
      window.removeEventListener('focus', focused)
    }
  }, [refresh])
  const current = loaded?.workspacePath === workspacePath ? loaded : undefined
  return {
    configs: current?.configs ?? null,
    packages: current?.packages ?? null,
    error,
    setError,
    refresh,
  }
}
