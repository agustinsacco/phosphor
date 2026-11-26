import { isDeepStrictEqual } from 'node:util'
import {
  AGENT_FIELDS,
  agentFieldValue,
  withAgentField,
  type AgentFieldKey,
} from '@phosphor/shared/machine-agent-behavior'
import type { AgentDirectivePrefs } from '@phosphor/shared/models'
import type { MachineSettingsSection } from '@phosphor/shared/machine-settings'
import type { UndoPorts } from '@phosphor/session-runtime/ops/undo'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import {
  directiveResult,
  fields,
  op,
  dataResult,
  pageInventory,
} from '@phosphor/session-runtime/ops/results'
import { readGlobalInstructions } from '@phosphor/session-runtime/pi/global-instructions'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import type { DaemonHandlerDeps } from './index'
import { readSection, patchSection, projectId, settingsOps } from './settings-access'

function headroom(deps: DaemonHandlerDeps) {
  const port = settingsOps(deps).headroom
  if (!port) throw new OpRefusal('unavailable', 'Headroom is not managed on this machine.')
  return port
}
function settingValue(agent: Record<string, unknown>, key: string) {
  return (
    (Object.hasOwn(AGENT_FIELDS, key)
      ? agentFieldValue(agent, AGENT_FIELDS[key as AgentFieldKey].path)
      : agent[key]) ?? null
  )
}
/** The settings writes whose Undo `settingsAreCurrent` checks. */
export const SETTINGS_UNDO_OPS: ReadonlySet<string> = new Set([
  'settings.set',
  'directives.set',
  'claude.routing',
  'claude.reorder',
])
export function settingsAreCurrent(deps: DaemonHandlerDeps): UndoPorts['isCurrent'] {
  return async ({ op, undoRecord: { forward: a } }) => {
    if (!a || a.project) return false
    if (op === 'settings.set' && a.key === 'headroom')
      return (await headroom(deps)['headroom.status']()).enabled === a.value
    if (op === 'settings.set' || op === 'directives.set') {
      const { agent } = await readSection(deps, 'agent')
      if (!agent) return false
      if (op === 'directives.set')
        return agent.agentDirectives?.[a.key as keyof AgentDirectivePrefs] === a.on
      return (
        settingValue({ ...agent }, String(a.key)) ===
        (a.key === 'contextBudget' ? String(a.value ?? '') : a.value)
      )
    }
    if (op === 'claude.routing' || op === 'claude.reorder') {
      const { providers } = await readSection(deps, 'providers')
      return (
        !!providers &&
        (op === 'claude.routing'
          ? providers.mode === a.mode && (!a.pinnedId || a.pinnedId === providers.pinnedId)
          : isDeepStrictEqual(
              providers.accounts.map((v) => v.id),
              a.ids,
            ))
      )
    }
    return false
  }
}
function instructions(deps: DaemonHandlerDeps, project: unknown, c: OpHandlerContext) {
  const settings = settingsOps(deps).settings
  return settings.workspace(projectId(deps, project, c)) ?? settings.agentDir
}
function agentHandlers(deps: DaemonHandlerDeps) {
  return {
    'settings.read': op(async (a, c) => {
      if (a.section === 'headroom') return dataResult(await headroom(deps)['headroom.status']())
      return dataResult(
        await readSection(
          deps,
          (a.section ?? 'agent') as MachineSettingsSection,
          projectId(deps, a.project, c),
          c.signal,
        ),
      )
    }),
    'settings.set': op(async (a, c) => {
      const key = String(a.key)
      if (key === 'headroom') {
        if (a.project || typeof a.value !== 'boolean')
          throw new OpRefusal('bad-request', 'Headroom is a machine-wide switch.')
        const h = headroom(deps)
        const { enabled } = await h['headroom.status']()
        c.signal.throwIfAborted()
        await h['headroom.set']({ enabled: a.value })
        return { text: 'Updated Headroom.', before: { key, value: enabled } }
      }
      const snapshot = await readSection(deps, 'agent', projectId(deps, a.project, c), c.signal)
      const value =
        key === 'contextBudget' && typeof a.value === 'number' ? String(a.value) : a.value
      const patch = Object.hasOwn(AGENT_FIELDS, key)
        ? withAgentField({}, AGENT_FIELDS[key as AgentFieldKey].path, value)
        : { [key]: value }
      await patchSection(deps, snapshot, { type: 'agent.patch', patch }, c)
      return {
        text: `Updated ${key}.`,
        before: a.project ? undefined : { key, value: settingValue({ ...snapshot.agent }, key) },
      }
    }),
    'directives.read': op((a, c) => {
      const { global, project } = settingsOps(deps).settings.readDirectiveOverrides(
        projectId(deps, a.project, c),
      )
      return directiveResult(global, project)
    }),
    'directives.set': op(async (a, c) => {
      const key = a.key as keyof AgentDirectivePrefs
      if (
        typeof a.project === 'string' &&
        !deps.store.listRepositories().some((r) => r.id === a.project)
      )
        throw new OpRefusal('bad-request', 'Select a registered Host folder.')
      const id = projectId(deps, a.project, c)
      const ports = settingsOps(deps)
      let folder: string | undefined
      let before
      if (id)
        folder = await ports.settings.setFolderDirective(
          id,
          key,
          a.on as boolean,
          () => !c.signal.aborted,
        )
      else {
        const snapshot = await readSection(deps, 'agent', undefined, c.signal)
        before = { key, on: snapshot.agent?.agentDirectives?.[key] }
        await patchSection(
          deps,
          snapshot,
          { type: 'agent.patch', patch: { agentDirectives: { [key]: a.on } } },
          c,
        )
      }
      const skipped = await ports.refreshDirectives(folder)
      return {
        text: `Updated ${key}.` + (skipped ? ` ${skipped} live lanes need a restart.` : ''),
        before,
      }
    }),
  }
}
function instructionHandlers(deps: DaemonHandlerDeps) {
  return {
    'instructions.read': op((a, c) =>
      dataResult(readGlobalInstructions(instructions(deps, a.project, c), { followLinks: false })),
    ),
    'instructions.edit': op(async (a, c) => {
      const dir = instructions(deps, a.project, c)
      const base = readGlobalInstructions(dir, { followLinks: false })
      if (
        base.exists
          ? a.revision !== base.revision
          : a.revision !== null && a.revision !== base.revision
      )
        throw new OpRefusal('bad-request', 'Instructions changed. Read them again.')
      await settingsOps(deps).settings.writeInstructions(
        a.content as string,
        base.revision,
        () => !c.signal.aborted,
        dir,
      )
      return { text: 'Updated instructions.' }
    }),
  }
}
export function settingsHandlers(deps: DaemonHandlerDeps) {
  return {
    ...agentHandlers(deps),
    ...instructionHandlers(deps),
    'claude.accounts': op(async (_, c) => {
      const rows = await settingsOps(deps).settings.accountMetadata()
      return pageInventory(rows, c, fields('id', 'label', 'plan'), {
        surface: { limit: rows.length },
      })
    }),
    'claude.routing': op(async (a, c) => {
      const snapshot = await readSection(deps, 'providers', undefined, c.signal)
      const before = snapshot.providers
      await patchSection(deps, snapshot, { type: 'claude.routing', ...a }, c)
      return {
        text: 'Updated Claude routing.',
        before:
          before && (!a.pinnedId || before.pinnedId)
            ? {
                mode: before.mode,
                ...(a.pinnedId && before.pinnedId ? { pinnedId: before.pinnedId } : {}),
              }
            : undefined,
      }
    }),
    'claude.reorder': op(async (a, c) => {
      const snapshot = await readSection(deps, 'providers', undefined, c.signal)
      const ids = snapshot.providers?.accounts.map((v) => v.id)
      await patchSection(deps, snapshot, { type: 'claude.reorder', ids: a.ids }, c)
      return { text: 'Updated Claude account order.', before: ids?.length ? { ids } : undefined }
    }),
    'account.move': op(async (a, c) => {
      if (!c.lane?.sessionId || c.principal.kind !== 'agent')
        throw new OpRefusal('bad-request', 'Select your own live Claude lane.')
      return {
        text: 'Moving this lane to the selected account after this turn.',
        deferred: [{ kind: 'account', accountId: String(a.accountId) }],
      }
    }),
  }
}
