import type { SkillBundle } from '@phosphor/shared/host-protocol-skill-share'
import { op, dataResult, fields, pageInventory } from '@phosphor/session-runtime/ops/results'
import type { OpHandler, OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import {
  createSkill,
  deleteSkill,
  editSkill,
  installSkill,
  projectIndex,
  project,
  type Target,
} from '../../features/skills/mutations'
import { NO_CONTENT_UNDO, resourceCall } from './resources-call'
import type { DaemonHandlerDeps } from './index'
export type { SkillPorts } from '../../features/skills/mutations'

function mutationPorts(deps: DaemonHandlerDeps, signal: AbortSignal) {
  return {
    skills: deps.skills,
    store: deps.store,
    installGlobal: (bundle: SkillBundle, overwrite: boolean) =>
      resourceCall(deps, 'skills.install', { bundle, overwrite }, signal),
  }
}
function askingLane(ctx: OpHandlerContext) {
  const ref = ctx.lane?.ref,
    laneId = ref && /\/lane:([^/]+)$/.exec(ref)?.[1]
  return laneId ? { laneId } : {}
}
export function skillHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  return {
    'skill.list': op<{ project?: string }>(async (a, ctx) => {
      const skills = a.project
        ? (await projectIndex(deps, await project(deps, a.project), ctx.signal)).map((s) => s.skill)
        : (
            (await resourceCall(deps, 'skills.list', askingLane(ctx), ctx.signal)) as {
              skills: { name: string; scope: string; description: string }[]
            }
          ).skills
      return pageInventory(skills, ctx, fields('name', 'scope', 'description'), {
        surface: { limit: skills.length },
        wrap: (skills) => ({ skills }),
      })
    }),
    'skill.read': op<{ name: string; file?: string }>(async (a, ctx) =>
      dataResult(await resourceCall(deps, 'skills.read', { ...a, ...askingLane(ctx) }, ctx.signal)),
    ),
    'skill.create': op<Target & { description: string; content?: string; draft?: boolean }>(
      async (a, ctx) => {
        await createSkill(mutationPorts(deps, ctx.signal), a, ctx)
        return { text: `Created ${a.name}.` }
      },
    ),
    'skill.edit': op<Target & { file?: string; content?: string }>(async (a, ctx) => {
      await editSkill(mutationPorts(deps, ctx.signal), a, ctx)
      return { text: `Edited ${a.name}. ${NO_CONTENT_UNDO}` }
    }),
    'skill.install': op<Target & { libraryId: string; overwrite?: boolean }>(async (a, ctx) => ({
      text: `Installed ${a.name}. New lanes get it; run phosphor lane reload to use it in this lane.`,
      data: await installSkill(mutationPorts(deps, ctx.signal), a, ctx),
    })),
    'skill.delete': op<Target>(async (a, ctx) => {
      await deleteSkill(mutationPorts(deps, ctx.signal), a, ctx)
      return { text: `Moved ${a.name} to Trash.` }
    }),
  }
}
