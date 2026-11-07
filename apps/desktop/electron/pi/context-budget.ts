import { createContextBudgetRuntime } from '@phosphor/session-runtime/pi/context-budget'
import { log } from '../debug-log'

// One desktop instance shared by startup, IPC and routines, as before.
export const { enforceContextBudget, watchContextBudget, withBudgetCompaction } =
  createContextBudgetRuntime(log)
