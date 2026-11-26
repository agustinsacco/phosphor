import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { checkPackageUpdates } from '@phosphor/session-runtime/pi/package-updates'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { readAgentSettings } from '@phosphor/session-runtime/pi/agent-settings'
import { readGlobalInstructions } from '@phosphor/session-runtime/pi/global-instructions'
import { piAgentDir } from '@phosphor/session-runtime/pi/pi-paths'
import { liveOpLanes, projectFolders } from './lanes'
import {
  op,
  cachedMcpStatus,
  dataResult,
  directiveResult,
  fields,
  modelColumns,
  pageInventory,
  routineColumns,
  routineRunColumns,
  pageOffset,
  pageLimit,
  surfaceInventory,
} from '@phosphor/session-runtime/ops/results'
import { requestPage } from '@phosphor/session-runtime/ops/ports'
import { ROUTINE_LIMITS } from '@phosphor/shared/host-protocol-routines'

const legacy = { surface: { limit: 50, shrink: true } } as const

async function project(explicit: string | undefined, cwd?: string) {
  if (explicit && explicit !== cwd && !(await projectFolders()).includes(explicit))
    throw new OpRefusal('bad-request', 'Unknown local workspace.')
  return explicit ?? cwd
}
async function connectors(cwd?: string) {
  const r = await (await import('../pi/mcp-actions')).listMcpServers(cwd)
  if (!r.ok) throw new Error('Could not list MCP servers.')
  return r.servers.map(({ name, scope, enabled, exposure, transport, state }) => ({
    name,
    scope,
    enabled,
    exposure,
    transport,
    state,
  }))
}
async function packages(cwd?: string) {
  return (await listPackages(cwd)).map(({ name, version, scope, kind, installed }) => ({
    name,
    version,
    scope,
    kind,
    installed,
  }))
}
async function models() {
  return (await import('../pi/catalogue')).catalogueModels()
}
async function providers() {
  return [...new Set((await models()).map((m) => m.provider))]
}
async function settings(section = 'agent', cwd?: string) {
  if (section === 'providers') return providers()
  if (section === 'resources') return packages(cwd)
  if (section === 'connectors') return connectors(cwd)
  if (section === 'instructions')
    return readGlobalInstructions(piAgentDir(), { followLinks: false })
  const prefs = (await import('../store')).getPrefs()
  if (section === 'headroom') return prefs.headroom
  if (section === 'advanced')
    return { contextBudget: prefs.contextBudget, contextFiles: prefs.contextFiles }
  const { defaultProvider, defaultModel, defaultThinkingLevel } = await readAgentSettings(cwd)
  return { defaultProvider, defaultModel, defaultThinkingLevel, contextBudget: prefs.contextBudget }
}
async function routineRuns({ id, offset }: { id?: string; offset?: number }, c: OpHandlerContext) {
  const start = requestPage(c) === undefined ? (offset ?? 0) : pageOffset(c)
  const limit = surfaceInventory(c) ? ROUTINE_LIMITS.history : pageLimit(c)
  const { repository } = (await import('../routines')).routineScheduler()
  if (id) repository.get(id)
  const rows = repository
    .history(id, start, limit + 1)
    .map(({ id, routineId, status, scheduledAt, startedAt, endedAt }) => ({
      id,
      routineId,
      status,
      scheduledAt,
      startedAt,
      endedAt,
    }))
  return pageInventory(rows, c, routineRunColumns, { windowOffset: start, limit })
}
export const inventoryHandlers = {
  'machine.status': op(() =>
    dataResult({
      machine: 'This Mac',
      runtime: 'in-app',
      platform: process.platform,
      arch: process.arch,
      liveLanes: liveOpLanes().length,
    }),
  ),
  'machine.doctor': op(async () =>
    dataResult(await (await import('../pi/health')).cachedPiHealth()),
  ),
  'machine.models': op<{ provider?: string }>(async ({ provider }, c) =>
    pageInventory(
      (await models()).filter((m) => !provider || m.provider === provider),
      c,
      modelColumns,
      legacy,
    ),
  ),
  'machine.providers': op(async (_, c) => {
    const rows = await providers()
    return pageInventory(rows, c, { id: (p) => p }, { surface: { limit: rows.length } })
  }),
  'machine.commands': op<{ project?: string }>(async (a, c) => {
    const cwd = await project(a.project, c.lane?.cwd)
    const result = await (await import('../pi/catalogue')).piCommands(cwd)
    if (result.error) throw new Error(result.error)
    return pageInventory(result.commands, c, fields('name', 'source', 'description'), legacy)
  }),
  'machine.usage': op(async () =>
    dataResult(await (await import('../pi/codex-usage')).fetchCodexUsage(false)),
  ),
  'routine.list': op(async (_a, c) =>
    pageInventory(
      (await import('../routines')).routinesSnapshot().routines,
      c,
      routineColumns,
      legacy,
    ),
  ),
  'directives.read': op<{ project?: boolean | string }>(async ({ project }, c) => {
    if (typeof project === 'string')
      throw new OpRefusal('bad-request', 'Use --project from a local workspace lane.')
    if (project && !c.lane?.cwd)
      throw new OpRefusal('bad-request', 'Use --project from a local workspace lane.')
    const prefs = (await import('../store')).getPrefs()
    return directiveResult(
      prefs.agentDirectives,
      project ? (prefs.agentDirectivesByProject[c.lane!.cwd] ?? null) : undefined,
    )
  }),
  'settings.read': op<{ section?: string; project?: string }>(async (a, c) =>
    dataResult(await settings(a.section, await project(a.project, c.lane?.cwd))),
  ),
  'mcp.check': op<{ name: string; project?: string }>(async ({ name, project: path }, c) => {
    const cwd = await project(path, c.lane?.cwd)
    const snapshots = await (await import('../pi/mcp-inspection')).readMcpChecks(cwd)
    const snapshot = Object.hasOwn(snapshots, name) ? snapshots[name] : undefined
    const server = { name, state: snapshot?.report.state }
    return { text: cachedMcpStatus(server, snapshot?.checkedAt), data: server }
  }),
  'claude.accounts': op(async (_, c) => {
    const { accounts } = (await import('../store')).getClaudeAccountPrefs()
    const shown = accounts.map(({ id, label, plan }) => ({ id, label, plan }))
    return pageInventory(shown, c, fields('id', 'label', 'plan'))
  }),
  'sandbox.list': op(async (_, c) => {
    const { sandboxBase } = await import('../sandbox-service')
    const { listSandboxFolders } = await import('@phosphor/session-runtime/sandboxes/folders')
    return pageInventory(listSandboxFolders(sandboxBase()), c, fields('name', 'path'))
  }),
  'mcp.list': op<{ project?: string }>(async (a, c) =>
    pageInventory(
      await connectors(await project(a.project, c.lane?.cwd)),
      c,
      fields('name', 'scope', 'enabled', 'transport', 'state'),
      legacy,
    ),
  ),
  'package.list': op<{ project?: string }>(async (a, c) =>
    pageInventory(
      await packages(await project(a.project, c.lane?.cwd)),
      c,
      fields('name', 'version', 'scope', 'installed'),
      legacy,
    ),
  ),
  'package.checkUpdates': op<{ project?: string }>(async (a, c) => {
    const updates = await checkPackageUpdates(
      await listPackages(await project(a.project, c.lane?.cwd)),
    )
    return pageInventory(
      Object.entries(updates),
      c,
      { spec: ([spec]) => spec, latest: ([, latest]) => latest },
      { wrap: Object.fromEntries },
    )
  }),
  'routine.history': op<{ id?: string; offset?: number; runId?: string }>((a, c) => {
    if (a.runId)
      throw new OpRefusal('unsupported', 'Read saved routines through the Phosphor service.')
    if (!a.id) throw new OpRefusal('bad-request', 'Supply a routine id for history.')
    return routineRuns(a, c)
  }),
  'routine.activity': op<{ offset?: number }>(routineRuns),
  'skill.list': op<{ project?: string }>(async (a, c) =>
    pageInventory(
      (
        await (
          await import('../pi/skill-actions')
        ).listSkills(await project(a.project, c.lane?.cwd))
      ).skills,
      c,
      fields('name', 'scope', 'description'),
      legacy,
    ),
  ),
  'skill.read': op<{ name: string; file?: string }>(async ({ name, file = 'SKILL.md' }, c) => {
    const { skills } = await (await import('../pi/skill-actions')).listSkills(c.lane?.cwd)
    const skill = skills.find((s) => s.name === name)
    if (!skill || !skill.files.some((f) => f.path === file))
      throw new OpRefusal('bad-request', 'Unknown skill file.')
    const { readSkillFileEntry, within } = await import('../pi/skills/bundle')
    if (!within(await realpath(skill.dir), await realpath(join(skill.dir, file))))
      throw new OpRefusal('bad-request', 'File is outside the skill.')
    return dataResult(await readSkillFileEntry(skill.dir, file))
  }),
}
