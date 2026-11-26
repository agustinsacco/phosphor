import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveCatalogBundle } from '@phosphor/session-runtime/skills/catalog'
import {
  installSkillBundle,
  resolvesElsewhere,
} from '@phosphor/session-runtime/skills/share-bundle'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { op, dataResult } from '@phosphor/session-runtime/ops/results'
import type { OpHandler, OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { composeSkillMd } from '@phosphor/shared/skills'
import {
  isShareablePath,
  isShareableSkillName,
  parseSkillBundle,
} from '@phosphor/shared/host-protocol-skill-share'
import { mutationPath, revision } from '../../features/writes/guards'
import { writeText } from '../../features/writes/text'
import { trashEntry } from '../../features/writes/trash'
import type { FeatureContext } from '../../features/feature'
import type { LocatedSkill } from '../../features/skills'
import { confineToRoots } from '../../machine/repositories'
import { NO_CONTENT_UNDO, resourceCall } from './resources-call'
import { featureError } from '../../features/failure'
import { refusal } from './lane-target'
import type { DaemonHandlerDeps } from './index'

export interface SkillPorts {
  agentDir: string
  context: FeatureContext
  invalidate?(): void
  resolveProject(cwd: string, signal?: AbortSignal): Promise<LocatedSkill[]>
}
type Target = { scope: 'user' | 'project'; name: string; project?: string }
const invalid = (msg: string) => new OpRefusal('bad-request', msg)
function ports(deps: DaemonHandlerDeps) {
  if (!deps.skills) throw new OpRefusal('unavailable', 'Skills unavailable.')
  return deps.skills
}
async function projectIndex(deps: DaemonHandlerDeps, cwd: string, signal: AbortSignal) {
  const skills = ports(deps)
  try {
    return await skills.resolveProject(cwd, signal)
  } catch (error) {
    const { code, message } = featureError(error).error
    throw refusal(code, message)
  }
}
async function project(deps: DaemonHandlerDeps, path: string | undefined) {
  const roots = deps.store.listRepositories().map((r) => r.path)
  const cwd = path && (await confineToRoots(path, roots))
  if (!cwd || cwd.split('/').some((p) => p.toLowerCase() === '.git'))
    throw invalid('Choose a configured project folder.')
  return cwd
}
/** Check each ancestor before creating a missing component. Never follow a project .pi symlink. */
async function directories(base: string, path: string) {
  let dir = base
  for (const part of path.split('/')) {
    dir = await mutationPath(dir, part, true)
    try {
      await mkdir(dir, { mode: 0o700 })
    } catch (e) {
      if (!errnoIs(e, 'EEXIST')) throw e
    }
    if (!(await lstat(dir)).isDirectory() || (await realpath(dir)) !== dir)
      throw invalid('Not a writable skill folder.')
  }
  return dir
}
async function destination(deps: DaemonHandlerDeps, target: Target, ctx: OpHandlerContext) {
  if (!isShareableSkillName(target.name)) throw invalid('Invalid skill name.')
  if (target.scope === 'user') {
    if (target.project !== undefined) throw invalid('A user skill has no project.')
    const base = await realpath(ports(deps).agentDir)
    return { root: await directories(base, 'skills') }
  }
  const cwd = await project(deps, target.project ?? ctx.lane?.cwd)
  return { root: await directories(cwd, '.pi/skills'), cwd }
}
async function bundleDirectory(root: string, name: string) {
  const dir = await mutationPath(root, name)
  if (!(await lstat(await mutationPath(dir, 'SKILL.md'))).isFile())
    throw invalid('Not a writable skill bundle.')
  return dir
}
function editSkill(deps: DaemonHandlerDeps) {
  return op<Target & { file?: string; content?: string }>(async (a, ctx) => {
    const file = a.file ?? 'SKILL.md'
    if (a.content === undefined || !isShareablePath(file.toLowerCase()))
      throw invalid('Supply skill content and a relative skill file.')
    const { root } = await destination(deps, a, ctx),
      dir = await bundleDirectory(root, a.name)
    if (dirname(file) !== '.') await directories(dir, dirname(file))
    const expected = await revision(await mutationPath(dir, file, true))
    await writeText(dir, {
      type: 'files.write',
      path: file,
      expected,
      content: a.content,
    })
    ports(deps).invalidate?.()
    return { text: `Edited ${a.name}. ${NO_CONTENT_UNDO}` }
  })
}
function installSkill(deps: DaemonHandlerDeps) {
  return op<Target & { libraryId: string; overwrite?: boolean }>(async (a, ctx) => {
    const text = `Installed ${a.name}. New lanes get it; run phosphor lane reload to use it in this lane.`
    const selected = await resolveCatalogBundle({ libraryId: a.libraryId, skillName: a.name })
    const bundle = parseSkillBundle({
      name: a.name,
      files: selected.bundle.map((f) => ({ path: f.rel, data: f.data.toString('base64') })),
    })
    if (!bundle) throw invalid('This catalog entry is not an installable skill bundle.')
    ctx.signal.throwIfAborted()
    const { root, cwd } = await destination(deps, a, ctx)
    if (!cwd) {
      const result = await resourceCall(
        deps,
        'skills.install',
        { bundle, overwrite: a.overwrite ?? false },
        ctx.signal,
      )
      if ((result as { status?: string }).status !== 'installed')
        throw invalid('A skill with that name already exists.')
      return { text, data: result }
    }
    const entry = (await projectIndex(deps, cwd, ctx.signal)).find(
      (s) => s.skill.name === a.name && s.skill.scope === 'project',
    )
    const elsewhere = !!entry && (await resolvesElsewhere(root, a.name, entry.file))
    ctx.signal.throwIfAborted()
    if ((await realpath(root)) !== root) throw invalid('The project skill folder changed.')
    const result = await installSkillBundle({
      root,
      bundle,
      elsewhere,
      overwrite: a.overwrite ?? false,
    })
    if (result.status === 'conflict') throw invalid('A skill with that name already exists.')
    ports(deps).invalidate?.()
    return { text, data: result }
  })
}
function askingLane(ctx: OpHandlerContext) {
  const ref = ctx.lane?.ref,
    laneId = ref && /\/lane:([^/]+)$/.exec(ref)?.[1]
  return laneId ? { laneId } : {}
}
export function skillHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  return {
    'skill.list': op<{ project?: string }>(async (a, ctx) => {
      if (!a.project)
        return dataResult(await resourceCall(deps, 'skills.list', askingLane(ctx), ctx.signal))
      const skills = await projectIndex(deps, await project(deps, a.project), ctx.signal)
      return dataResult({ skills: skills.map((s) => s.skill) })
    }),
    'skill.read': op<{ name: string; file?: string }>(async (a, ctx) =>
      dataResult(await resourceCall(deps, 'skills.read', { ...a, ...askingLane(ctx) }, ctx.signal)),
    ),
    'skill.create': op<Target & { description: string; content?: string; draft?: boolean }>(
      async (a, ctx) => {
        const { root } = await destination(deps, a, ctx)
        const content = composeSkillMd({ ...a, content: a.content ?? '', draft: a.draft ?? false })
        const result = await installSkillBundle({
          root,
          bundle: {
            name: a.name,
            files: [{ path: 'SKILL.md', data: Buffer.from(content).toString('base64') }],
          },
          overwrite: false,
          elsewhere: false,
        })
        if (result.status !== 'installed') throw invalid('A skill with that name already exists.')
        ports(deps).invalidate?.()
        return { text: `Created ${a.name}.` }
      },
    ),
    'skill.edit': editSkill(deps),
    'skill.install': installSkill(deps),
    'skill.delete': op<Target>(async (a, ctx) => {
      const { root } = await destination(deps, a, ctx)
      await bundleDirectory(root, a.name)
      await trashEntry(ports(deps).context, root, a.name)
      ports(deps).invalidate?.()
      return { text: `Moved ${a.name} to Trash.` }
    }),
  }
}
