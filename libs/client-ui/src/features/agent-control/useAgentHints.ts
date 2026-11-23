import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionsStore } from '@/stores/sessions'
import { useAgentLaneScope } from './laneScope'
import { machineEventKey, readChanges } from './agentOps'

type Field = 'model' | 'thinking'
type Hints = Partial<Record<Field, string | undefined>>
// Window-only; the live lane handle owns the hints, not the currently mounted picker.
const remembered = new WeakMap<object, { lane: string; hints: Hints }>()
const fields = ['model', 'thinking'] as const
/** The lane signal contains field names, not prose. Get the reason from the
 * matching successful audit row. A late read cannot overwrite a user's pick. */
export function useAgentHints(sessionId: string) {
  const { machine, lane } = useAgentLaneScope(sessionId)
  const entry = useSessionsStore((s) => s.live[sessionId])
  const [hints, setHints] = useState<Hints>({})
  const put = useCallback(
    (field: Field, reason: string | undefined) => {
      if (!entry || !lane) return
      const current = remembered.get(entry)
      const next = { ...(current?.lane === lane ? current.hints : {}), [field]: reason }
      remembered.set(entry, { lane, hints: next })
      setHints(next)
    },
    [entry, lane],
  )
  const versions = useRef({ model: 0, thinking: 0 })
  const clear = useCallback(
    (field: Field) => {
      versions.current[field]++
      put(field, undefined)
    },
    [put],
  )
  useEffect(() => {
    const saved = entry && remembered.get(entry)
    setHints(saved && saved.lane === lane ? saved.hints : {})
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
            put(
              field,
              row ? `Changed by the agent${row.reason ? `: ${row.reason}` : ''}` : undefined,
            )
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
  }, [machine, lane, entry, clear, put])
  return { ...hints, clear }
}
