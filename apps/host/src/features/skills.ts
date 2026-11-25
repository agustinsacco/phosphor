import { machineCatalogues } from './machine-catalogue'
import { probeDeadline, probeQueue, type ProbeSlot } from './probe-queue'
import { isUtf8 } from 'node:buffer'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { readSkillBundle, SkillShareError } from '@phosphor/session-runtime/skills/share-bundle'
import {
  machineRecord,
  MACHINE_LIMITS,
  parseMachineParams,
  parseMachineSkills,
  type MachineSkill,
} from '@phosphor/shared/host-protocol-machine'
import type { FeatureContext, HostFeature } from './feature'
import {
  FeatureFailure,
  featureError,
  featureInspection,
  machineCall,
  queryMachine,
  type MachinePorts,
} from './machine'

const within = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}
async function laneCwd(context: FeatureContext, laneId?: string): Promise<string> {
  if (!laneId) return context.home
  const lane = context.store.getLane(laneId)
  const repo = lane && context.store.listRepositories().find((r) => r.id === lane.repositoryId)
  if (!lane || lane.removedAt !== null || !repo) throw new FeatureFailure('unknown-lane')
  try {
    const cwd = await realpath(lane.cwd)
    if (!within(await realpath(repo.path), cwd)) throw new FeatureFailure('unknown-lane')
    return cwd
  } catch {
    throw new FeatureFailure('unknown-lane')
  }
}
export interface LocatedSkill {
  skill: MachineSkill
  file: string
  cwd?: string
}
/** Resolve through this Host's pi; a project skill shadows a global one of the same name. */
export async function resolveSkills(
  context: FeatureContext,
  ports: MachinePorts,
  laneId?: string,
  admittedProject?: string,
  slot?: ProbeSlot,
): Promise<LocatedSkill[]> {
  const cwd = admittedProject ?? (await laneCwd(context, laneId))
  const pi = ports.pi ?? (await featureInspection(context, ports)).pi
  if (!pi) throw new FeatureFailure('internal')
  return locateSkills(pi, cwd, !!(laneId || admittedProject), slot)
}
async function locateSkills(
  pi: NonNullable<MachinePorts['pi']>,
  cwd: string,
  project: boolean,
  slot?: ProbeSlot,
) {
  const commands = await queryMachine(pi, cwd, 'get_commands', undefined, slot)
  if (!Array.isArray(commands) || commands.length > 2000) throw new FeatureFailure('too-large')
  const skills = new Map<string, LocatedSkill>()
  let count = 0
  for (const c of commands) {
    if (!machineRecord(c) || c.source !== 'skill') continue
    if (typeof c.name !== 'string') throw new FeatureFailure('internal')
    if (++count > MACHINE_LIMITS.skills) throw new FeatureFailure('too-large')
    const source = c.sourceInfo
    if (!machineRecord(source) || typeof source.path !== 'string' || !isAbsolute(source.path))
      throw new FeatureFailure('internal')
    if (source.scope !== 'user' && source.scope !== 'project') throw new FeatureFailure('internal')
    if (source.scope === 'project' && !project) continue
    if (source.scope === 'project' && !within(cwd, await realpath(source.path)))
      throw new FeatureFailure('bad-request')
    const parsed = parseMachineSkills([
      {
        name: c.name.replace(/^skill:/, ''),
        description: c.description ?? '',
        scope: source.scope,
      },
    ])
    const skill = parsed?.[0]
    if (!skill) throw new FeatureFailure('internal')
    // A project skill shadows a global skill with the same name; never depend on RPC order.
    if (skills.get(skill.name)?.skill.scope !== 'project')
      skills.set(skill.name, {
        skill,
        file: source.path,
        ...(source.scope === 'project' ? { cwd } : {}),
      })
  }
  return [...skills.values()].sort((a, b) => a.skill.name.localeCompare(b.skill.name))
}
async function readSkill(entry: LocatedSkill, file?: string) {
  const root = await realpath(dirname(entry.file))
  const path = file ? join(root, file) : entry.file
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await fd.stat()
    const canonical = await realpath(path)
    if (
      !info.isFile() ||
      !within(root, canonical) ||
      (entry.cwd !== undefined && !within(entry.cwd, canonical)) ||
      canonical.split('/').includes('.git')
    )
      throw new FeatureFailure('bad-request')
    const resolved = await stat(canonical)
    if (info.dev !== resolved.dev || info.ino !== resolved.ino)
      throw new FeatureFailure('bad-request')
    if (info.size > MACHINE_LIMITS.textBytes) throw new FeatureFailure('too-large')
    const bytes = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await fd.read(bytes, length, bytes.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > info.size) throw new FeatureFailure('too-large')
    const content = bytes.subarray(0, length)
    return content.includes(0) || !isUtf8(content)
      ? { binary: true, size: length }
      : { binary: false, size: length, content: content.toString('utf8') }
  } finally {
    await fd.close()
  }
}
/** Only a SKILL.md folder travels: a loose Markdown skill's folder is the whole skills root. */
async function exportSkill(entry: LocatedSkill) {
  if (basename(entry.file) !== 'SKILL.md') throw new FeatureFailure('bad-request')
  try {
    return await readSkillBundle(dirname(entry.file), entry.skill.name)
  } catch (error) {
    const tooLarge = error instanceof SkillShareError && error.code === 'too-large'
    throw new FeatureFailure(tooLarge ? 'too-large' : 'bad-request')
  }
}
export function createSkillsFeature(
  context: FeatureContext,
  ports: MachinePorts = {},
): HostFeature {
  const cache = machineCatalogues(context, ports)
  const readiness = probeQueue()
  const methods = [
    'machine.models',
    'machine.commands',
    'machine.providers',
    'machine.claude',
    'machine.claudeUsage',
    'skills.list',
    'skills.read',
    'skills.export',
  ]
  return {
    capability: 'skills.read',
    methods,
    async call(method, params) {
      if (!methods.includes(method)) return featureError(new FeatureFailure('unsupported'))
      const parsed = parseMachineParams(method, params)
      if (!parsed) return featureError(new FeatureFailure('bad-request'))
      return run(method, parsed)
    },
  }
  async function run(
    method: string,
    parsed: NonNullable<ReturnType<typeof parseMachineParams>>,
  ): Promise<Awaited<ReturnType<HostFeature['call']>>> {
    try {
      if (method === 'machine.models')
        return { ok: true, data: await cache.models(parsed.partial === true) }
      if (method === 'machine.commands')
        return { ok: true, data: await cache.commands(parsed.repositoryId) }
      if (method === 'machine.claudeUsage') return await machineCall(method, context, ports, parsed)
      if (method.startsWith('machine.'))
        return await readiness(() => machineCall(method, context, ports, parsed))
      if (method === 'skills.list') {
        const deadline = probeDeadline()
        const cwd = await laneCwd(context, parsed.laneId)
        const project = !!parsed.laneId
        const data = await cache.skills(cwd, project, deadline, async (pi, slot) => ({
          skills: (await locateSkills(pi, cwd, project, slot)).map((s) => s.skill),
        }))
        return { ok: true, data }
      }
      const skills = await cache.resourceQueue((slot) =>
        resolveSkills(context, ports, parsed.laneId, undefined, slot),
      )
      const entry = skills.find((s) => s.skill.name === parsed.name)
      if (!entry) throw new FeatureFailure('bad-request')
      if (method === 'skills.export') return { ok: true, data: await exportSkill(entry) }
      try {
        return { ok: true, data: await readSkill(entry, parsed.file) }
      } catch (error) {
        throw error instanceof FeatureFailure ? error : new FeatureFailure('bad-request')
      }
    } catch (error) {
      const result = featureError(error)
      context.log('feature.failed', {
        method,
        ...(parsed.laneId ? { laneId: parsed.laneId } : {}),
        reason: result.ok ? 'internal' : result.error.code,
      })
      return result
    }
  }
}
