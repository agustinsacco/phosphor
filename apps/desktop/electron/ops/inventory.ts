import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { readAgentSettings } from '@phosphor/session-runtime/pi/agent-settings'
import { readGlobalInstructions } from '@phosphor/session-runtime/pi/global-instructions'
import { piAgentDir } from '@phosphor/session-runtime/pi/pi-paths'
import { liveOpLanes, projectFolders } from './lanes'
import { op, dataResult, pageRows } from '@phosphor/session-runtime/ops/results'
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
  'machine.models': op(async (_a, c) => pageRows(await models(), c)),
  'machine.providers': op(async () => dataResult(await providers())),
  'machine.commands': op(async (_a, c) => {
    const result = await (await import('../pi/catalogue')).piCommands(c.lane?.cwd)
    if (result.error) throw new Error(result.error)
    return pageRows(result.commands, c)
  }),
  'machine.usage': op(async () =>
    dataResult(await (await import('../pi/codex-usage')).fetchCodexUsage(false)),
  ),
  'routine.list': op(async (_a, c) =>
    pageRows((await import('../routines')).routinesSnapshot().routines, c),
  ),
  'settings.read': op<{ section?: string; project?: string }>(async (a, c) =>
    dataResult(await settings(a.section, await project(a.project, c.lane?.cwd))),
  ),
  'mcp.list': op<{ project?: string }>(async (a, c) =>
    pageRows(await connectors(await project(a.project, c.lane?.cwd)), c),
  ),
  'package.list': op<{ project?: string }>(async (a, c) =>
    pageRows(await packages(await project(a.project, c.lane?.cwd)), c),
  ),
  'skill.list': op<{ project?: string }>(async (a, c) =>
    pageRows(
      (
        await (
          await import('../pi/skill-actions')
        ).listSkills(await project(a.project, c.lane?.cwd))
      ).skills,
      c,
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
