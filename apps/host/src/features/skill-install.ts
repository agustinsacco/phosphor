import { realpath } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { parseSkillInstallParams } from '@phosphor/shared/host-protocol-skill-share'
import { installSkillBundle, SkillShareError } from '@phosphor/session-runtime/skills/share-bundle'
import type { FeatureContext, FeatureOutcome, HostFeature } from './feature'
import { FeatureFailure, featureError, type MachinePorts } from './machine'
import { resolveSkills } from './skills'

const forbidden: FeatureOutcome = {
  ok: false,
  error: { code: 'forbidden', message: 'Configuration access is not granted.' },
}

/** Is the skill pi resolves for this name the folder an install would replace? */
async function inFolder(file: string, folder: string): Promise<boolean> {
  try {
    const rel = relative(await realpath(folder), await realpath(file))
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}

/**
 * `skills.install {bundle, overwrite?}` writes a shared skill into this Host's global pi skills
 * folder. It is machine configuration: only a configure grant reaches it, and authority is
 * checked again after pi resolves the existing skills and before anything is written.
 */
export function createSkillInstallFeature(
  context: FeatureContext,
  ports: MachinePorts & { skillsRoot: string },
): HostFeature {
  let tail: Promise<unknown> = Promise.resolve()
  let pending = 0
  async function install(params: unknown, authorized: () => boolean): Promise<FeatureOutcome> {
    const parsed = parseSkillInstallParams(params)
    if (!parsed) return featureError(new FeatureFailure('bad-request'))
    const { bundle, overwrite } = parsed
    try {
      const same = (await resolveSkills(context, ports)).find((s) => s.skill.name === bundle.name)
      const folder = join(ports.skillsRoot, bundle.name)
      const elsewhere = same !== undefined && !(await inFolder(same.file, folder))
      if (!authorized()) return forbidden
      const data = await installSkillBundle({
        root: ports.skillsRoot,
        bundle,
        overwrite,
        elsewhere,
      })
      context.log('skills.install', { name: bundle.name, status: data.status })
      return { ok: true, data }
    } catch (error) {
      const failure =
        error instanceof FeatureFailure
          ? error
          : new FeatureFailure(error instanceof SkillShareError ? 'bad-request' : 'internal')
      context.log('feature.failed', { method: 'skills.install', reason: failure.code })
      return featureError(failure)
    }
  }
  return {
    capability: 'machine.configure',
    methods: ['skills.install'],
    async call(method, params, authorized = () => false) {
      if (method !== 'skills.install') return featureError(new FeatureFailure('unsupported'))
      if (!authorized()) return forbidden
      if (pending >= 4) return featureError(new FeatureFailure('internal'))
      pending++
      const run = tail.then(() => install(params, authorized))
      tail = run.catch(() => undefined)
      try {
        return await run
      } finally {
        pending--
      }
    },
  }
}
