import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { McpResolvedServer } from '@shared/mcp'
import type { McpCheckSnapshot } from '@shared/mcp-inspection'
import { errorText } from '@shared/errors'

export interface ConnectorCheckView {
  snapshot?: McpCheckSnapshot
  checking?: boolean
  error?: string
}
type Checks = Record<string, ConnectorCheckView>

function useCheckActions(
  workspacePath: string | undefined,
  setChecks: Dispatch<SetStateAction<Checks>>,
) {
  const generation = useRef(0)
  const pending = useRef(new Map<string, string>())
  const cancel = useCallback(() => {
    generation.current++
    for (const id of pending.current.values()) {
      window.phosphor.invoke('mcp:cancelCheck', id).catch(() => {})
    }
    pending.current.clear()
    setChecks((previous) =>
      Object.fromEntries(
        Object.entries(previous).map(([name, value]) => [
          name,
          value.checking ? { ...value, checking: false, error: 'Check cancelled.' } : value,
        ]),
      ),
    )
  }, [setChecks])
  const test = useCallback(
    async (name: string, epoch = generation.current): Promise<void> => {
      if (pending.current.has(name)) return
      const id = crypto.randomUUID()
      pending.current.set(name, id)
      setChecks((previous) => ({
        ...previous,
        [name]: { ...previous[name], error: undefined, checking: true },
      }))
      try {
        const result = await window.phosphor.invoke('mcp:checkServer', name, workspacePath, id)
        if (epoch !== generation.current) return
        setChecks((previous) => ({
          ...previous,
          [name]: result.ok
            ? { snapshot: result.snapshot }
            : { snapshot: previous[name]?.snapshot, error: result.message },
        }))
      } catch (error) {
        if (epoch === generation.current)
          setChecks((previous) => ({
            ...previous,
            [name]: { snapshot: previous[name]?.snapshot, error: errorText(error) },
          }))
      } finally {
        if (pending.current.get(name) === id) pending.current.delete(name)
      }
    },
    [workspacePath, setChecks],
  )
  return { generation, cancel, test }
}

/** One mounted machine/workspace scope. Never reuse a response after its scope/config changed. */
export function useConnectorChecks(
  workspacePath: string | undefined,
  servers: McpResolvedServer[],
  ready: boolean,
) {
  const [checks, setChecks] = useState<Checks>({})
  const [revision, setRevision] = useState(0)
  const scope = JSON.stringify([workspacePath, servers])
  const loadedScope = useRef('')
  const { generation, cancel, test } = useCheckActions(workspacePath, setChecks)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    cancel()
    if (loadedScope.current !== scope) setChecks({})
    loadedScope.current = scope
    if (!ready || !servers.length) return
    const epoch = generation.current
    const load = async () => {
      try {
        const snapshots = await window.phosphor.invoke('mcp:readChecks', workspacePath)
        if (epoch !== generation.current) return
        setChecks(
          Object.fromEntries(servers.map(({ name }) => [name, { snapshot: snapshots[name] }])),
        )
      } catch {
        /* Cache failure must not prevent a new test. */
      }
      if (epoch !== generation.current) return
      await Promise.all(servers.map(({ name }) => test(name, epoch)))
    }
    void load()
    return cancel
  }, [workspacePath, scope, servers, ready, revision, test, cancel, generation])
  return {
    checks: loadedScope.current === scope ? checks : {},
    test,
    cancel,
    refresh,
    checking: Object.values(checks).some((value) => value.checking),
  }
}
