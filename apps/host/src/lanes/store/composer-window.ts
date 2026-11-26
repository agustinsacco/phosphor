import type { DatabaseSync } from 'node:sqlite'
import type { LaneSummary } from '@phosphor/shared/host-protocol'
import type { RpcSessionState } from '@phosphor/shared/rpc'
import { sessionContextBudget } from '@phosphor/shared/context-budget'

type Model = NonNullable<LaneSummary['model']>
const KEY = 'composer_window'
const windowSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export function composerWindows(db: DatabaseSync) {
  return {
    remember(laneId: string, state: RpcSessionState) {
      const model = state.model
      if (!windowSize(model?.contextWindow)) return
      const value = JSON.stringify([
        model.provider,
        model.id,
        model.contextWindow,
        state.autoCompactionEnabled,
      ])
      db.prepare(
        `INSERT INTO lane_prefs (lane_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(lane_id, key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value`,
      ).run(laneId, KEY, value)
    },
    read(laneId: string, model: Model, catalogue: number | undefined, budget: string) {
      const row = db
        .prepare('SELECT value FROM lane_prefs WHERE lane_id=? AND key=?')
        .get(laneId, KEY)
      const saved: unknown = row && JSON.parse(String(row.value))
      const matched = Array.isArray(saved) && saved[0] === model.provider && saved[1] === model.id
      if (!windowSize(catalogue)) return matched && windowSize(saved[2]) ? saved[2] : undefined
      return (
        sessionContextBudget({
          raw: budget,
          contextWindow: catalogue,
          autoCompactionEnabled: !matched || saved[3] !== false,
        }) ?? catalogue
      )
    },
  }
}
