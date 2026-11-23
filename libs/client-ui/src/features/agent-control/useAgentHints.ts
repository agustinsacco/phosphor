import { useEffect, useRef, useState } from 'react'
import { useAgentLaneScope } from './laneScope'
import { machineEventKey, readChanges } from './agentOps'

type Field = 'model' | 'thinking'
const fields = ['model', 'thinking'] as const
/** The lane signal contains field names, not prose. Get the reason from the
 * matching successful audit row. A late read cannot overwrite a user's pick. */
export function useAgentHints(sessionId: string) {
  const { machine, lane } = useAgentLaneScope(sessionId)
  const [hints, setHints] = useState<Partial<Record<Field, string>>>({})
  const versions = useRef({ model: 0, thinking: 0 })
  const clear = (field: Field) => {
    versions.current[field]++
    setHints((v) => ({ ...v, [field]: undefined }))
  }
  useEffect(() => {
    setHints({})
    if (!lane) return
    let live = true
    const stop = window.phosphor?.onOpsChanged?.((event) => {
      if (
        event.kind !== 'lane' ||
        event.laneRef !== lane ||
        event.machine !== machineEventKey(machine)
      )
        return
      const changed = fields.filter((f) => event.fields?.includes(f))
      if (!changed.length) return
      const turns = changed.map((field) => ({ field, turn: ++versions.current[field] }))
      void readChanges(machine, lane).then(
        ({ rows }) => {
          if (!live) return
          for (const { field, turn } of turns) {
            if (turn !== versions.current[field]) continue
            const row = rows.find(
              (r) =>
                r.op === `${field}.set` &&
                r.laneRef === lane &&
                ['allowed', 'approved'].includes(r.decision),
            )
            setHints((h) => ({
              ...h,
              [field]: row
                ? `Changed by the agent${row.reason ? `: ${row.reason}` : ''}`
                : undefined,
            }))
          }
        },
        () => {
          if (live)
            for (const { field, turn } of turns) {
              if (turn === versions.current[field]) clear(field)
            }
        },
      )
    })
    return () => {
      live = false
      stop?.()
    }
  }, [machine, lane])
  return { ...hints, clear }
}
