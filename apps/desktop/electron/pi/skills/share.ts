/** This Mac's half of skill sharing: export a listed bundle, install one into the user root. */
import { join } from 'node:path'
import {
  isShareableSkillName,
  parseSkillBundle,
  type SkillBundle,
  type SkillInstallResult,
} from '@shared/host-protocol-skill-share'
import {
  installSkillBundle,
  readSkillBundle,
  resolvesElsewhere,
} from '@phosphor/session-runtime/skills/share-bundle'
import type { RpcSlashCommand } from '@shared/rpc'
import { registerKnownSkillDir, requireKnownSkillDir, skillRoots } from './bundle'

/** Only a directory the last `skills:list` reported can be exported. */
export function exportLocalSkill(name: unknown, dir: unknown): Promise<SkillBundle> {
  if (!isShareableSkillName(name) || typeof dir !== 'string')
    throw new Error('This skill cannot be shared.')
  return readSkillBundle(requireKnownSkillDir(dir), name)
}

/**
 * Install into `~/.pi/agent/skills/<name>`. `commands` is what pi resolves globally (empty when
 * pi is missing): a same-named global skill from anywhere else blocks the copy, overwrite or not.
 */
export async function installLocalSkill(
  bundle: unknown,
  overwrite: unknown,
  commands: RpcSlashCommand[],
): Promise<SkillInstallResult> {
  const parsed = parseSkillBundle(bundle)
  if (!parsed || typeof overwrite !== 'boolean') throw new Error('This skill cannot be shared.')
  const root = skillRoots().userRoot
  const folder = join(root, parsed.name)
  const same = commands.find(
    (c) =>
      c.source === 'skill' &&
      c.name.replace(/^skill:/, '') === parsed.name &&
      c.sourceInfo?.scope !== 'project',
  )
  const elsewhere =
    same !== undefined && (await resolvesElsewhere(root, parsed.name, same.sourceInfo?.path))
  const result = await installSkillBundle({ root, bundle: parsed, overwrite, elsewhere })
  if (result.status === 'installed') registerKnownSkillDir(folder)
  return result
}
