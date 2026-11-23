import { isDeepStrictEqual } from 'node:util'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'
import {
  AGENT_FIELDS,
  agentFieldValue,
  projectAgentBehavior,
  withAgentField,
} from '@phosphor/shared/machine-agent-behavior'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { op, dataResult } from '@phosphor/session-runtime/ops/results'
import { patchSection, projectId, readSection } from './settings-access'
import type { DaemonHandlerDeps } from './index'

/** Present the editable settings as JSON. Omitted reviewed keys clear; unknown keys stay on disk. */
function checkedContent(value: unknown) {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(value))
  } catch {
    throw new OpRefusal('bad-request', 'Provide a settings JSON object.')
  }
  if (!machineRecord(parsed) || !isDeepStrictEqual(projectAgentBehavior(parsed), parsed))
    throw new OpRefusal('forbidden', 'Only reviewed agent behavior settings can be edited here.')
  return parsed
}
export function configHandlers(deps: DaemonHandlerDeps) {
  const read = (file: unknown) => {
    if (file !== 'settings')
      throw new OpRefusal('forbidden', 'This file is not available to agent control.')
  }
  return {
    'config.read': op(async (a, c) => {
      read(a.file)
      const snapshot = await readSection(deps, 'agent', projectId(deps, a.project, c), c.signal)
      return dataResult({
        content: JSON.stringify(projectAgentBehavior({ ...snapshot.agent }), null, 2),
      })
    }),
    'config.write': op(async (a, c) => {
      read(a.file)
      const parsed = checkedContent(a.content)
      const snapshot = await readSection(deps, 'agent', projectId(deps, a.project, c), c.signal)
      let patch = {}
      for (const { path } of Object.values(AGENT_FIELDS)) {
        if (path[0] === 'defaultThinkingLevel') continue
        patch = withAgentField(patch, path, agentFieldValue(parsed, path) ?? null)
      }
      await patchSection(deps, snapshot, { type: 'agent.patch', patch }, c)
      return { text: 'Updated reviewed settings; unlisted settings were preserved.' }
    }),
  }
}
