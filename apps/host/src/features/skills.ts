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
import { withinProbe } from './failure'
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
  root: string
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
  if (!pi) throw new FeatureFailure('internal', 'missing-pi', 'inspection')
  return locateSkills(pi, cwd, !!(laneId || admittedProject), slot)
}
async function locateSkills(
  pi: NonNullable<MachinePorts['pi']>,
  cwd: string,
  project: boolean,
  slot?: ProbeSlot,
) {
  const commands = await queryMachine(pi, cwd, 'get_commands', undefined, slot)
  if (!Array.isArray(commands)) throw new FeatureFailure('internal', 'decode', 'pi reply')
  if (commands.length > 2000) throw new FeatureFailure('too-large')
  const skills = new Map<string, LocatedSkill>()
  let count = 0
  for (const c of commands) {
    if (!machineRecord(c) || c.source !== 'skill') continue
    if (typeof c.name !== 'string') throw new FeatureFailure('internal', 'decode', 'pi reply')
    if (++count > MACHINE_LIMITS.skills) throw new FeatureFailure('too-large')
    const source = c.sourceInfo
    if (!machineRecord(source) || typeof source.path !== 'string' || !isAbsolute(source.path))
      throw new FeatureFailure('internal', 'decode', 'pi reply')
    if (source.scope !== 'user' && source.scope !== 'project')
      throw new FeatureFailure('internal', 'decode', 'pi reply')
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
    if (!skill) throw new FeatureFailure('internal', 'decode', 'pi reply')
    // A project skill shadows a global skill with the same name; never depend on RPC order.
    const previous = skills.get(skill.name)
    if (!previous || (previous.skill.scope === 'user' && skill.scope === 'project'))
      skills.set(skill.name, {
        skill,
        file: source.path,
        root: await realpath(dirname(source.path)),
        ...(source.scope === 'project' ? { cwd } : {}),
      })
  }
  return [...skills.values()].sort((a, b) => a.skill.name.localeCompare(b.skill.name))
}
async function readSkill(entry: LocatedSkill, file?: string) {
  const { root } = entry
  if ((await realpath(dirname(entry.file))) !== root) throw new FeatureFailure('bad-request')
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
  if (basename(entry.file) !== 'SKILL.md' || (await realpath(dirname(entry.file))) !== entry.root)
    throw new FeatureFailure('bad-request')
  try {
    return await readSkillBundle(entry.root, entry.skill.name)
  } catch (error) {
    const tooLarge = error instanceof SkillShareError && error.code === 'too-large'
    throw new FeatureFailure(tooLarge ? 'too-large' : 'bad-request')
  }
}
const METHODS = [
  'machine.models',
  'machine.commands',
  'machine.providers',
  'machine.claude',
  'machine.claudeUsage',
  'machine.telemetry',
  'skills.list',
  'skills.read',
  'skills.export',
]

export function createSkillsFeature(
  context: FeatureContext,
  ports: MachinePorts = {},
  bindModelWindow?: (read: ReturnType<typeof machineCatalogues>['modelWindow']) => void,
): HostFeature & { resolveProject(cwd: string, signal?: AbortSignal): Promise<LocatedSkill[]> } {
  const cache = machineCatalogues(context, ports)
  bindModelWindow?.(cache.modelWindow)
  const readiness = probeQueue()
  return {
    capability: 'skills.read',
    methods: METHODS,
    async resolveProject(cwd, signal) {
      try {
        return await index(cwd, true, probeDeadline(), signal)
      } catch (error) {
        throw logFailure('skills.resolveProject', error)
      }
    },
    async call(method, params, _authorized, _clientId, signal) {
      if (!METHODS.includes(method)) return featureError(new FeatureFailure('unsupported'))
      const parsed = parseMachineParams(method, params)
      if (!parsed) return featureError(new FeatureFailure('bad-request'))
      return run(method, parsed, signal)
    },
  }
  function index(cwd: string, project: boolean, deadline: number, signal?: AbortSignal) {
    return cache.skills(
      cwd,
      project,
      deadline,
      (pi, slot) => locateSkills(pi, cwd, project, slot),
      signal,
    )
  }
  async function run(
    method: string,
    parsed: NonNullable<ReturnType<typeof parseMachineParams>>,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<HostFeature['call']>>> {
    const deadline = probeDeadline()
    try {
      if (method === 'machine.models')
        return { ok: true, data: await cache.models(parsed.partial === true) }
      if (method === 'machine.commands')
        return { ok: true, data: await cache.commands(parsed.repositoryId, deadline, signal) }
      if (method === 'machine.claudeUsage') return await machineCall(method, context, ports, parsed)
      // A resource read a client polls every couple of seconds. It must not
      // queue behind a doctor inspection that can hold the probe slot for 20s.
      if (method === 'machine.telemetry') return await machineCall(method, context, ports, parsed)
      if (method.startsWith('machine.'))
        return await readiness(
          () =>
            withinProbe(
              () => machineCall(method, context, ports, parsed),
              deadline,
              'inspection',
              signal,
            ),
          deadline,
          signal,
        )
      const cwd = await withinProbe(
        () => laneCwd(context, parsed.laneId),
        deadline,
        'inspection',
        signal,
      )
      const skills = await index(cwd, !!parsed.laneId, deadline, signal)
      return await skillAnswer(method, parsed, skills, deadline, signal)
    } catch (error) {
      return featureError(logFailure(method, error))
    }
  }
  function logFailure(method: string, error: unknown) {
    const failure = error instanceof FeatureFailure ? error : new FeatureFailure('internal')
    context.log('feature.failed', {
      method,
      phase: failure.phase ?? 'feature',
      cause: failure.cause ?? failure.code,
    })
    return failure
  }
}

async function skillAnswer(
  method: string,
  parsed: { name?: string; file?: string },
  skills: LocatedSkill[],
  deadline: number,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<HostFeature['call']>>> {
  if (method === 'skills.list')
    return { ok: true, data: { skills: skills.map((entry) => entry.skill) } }
  const entry = skills.find((s) => s.skill.name === parsed.name)
  if (!entry) throw new FeatureFailure('bad-request')
  if (method === 'skills.export') return { ok: true, data: await exportSkill(entry) }
  try {
    return {
      ok: true,
      data: await withinProbe(() => readSkill(entry, parsed.file), deadline, 'skill read', signal),
    }
  } catch (error) {
    throw error instanceof FeatureFailure ? error : new FeatureFailure('bad-request')
  }
}
