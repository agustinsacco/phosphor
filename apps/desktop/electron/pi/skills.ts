/**
 * Skills page backend: what skills resolve, and every mutation on them.
 *
 * Resolution asks pi itself — a throwaway `pi --mode rpc --no-session`
 * answering `get_commands` (the model-catalogue machinery, no tokens spent).
 * pi's answer carries each skill's path, scope and source, so Phosphor never
 * re-implements the discovery chain (six roots, settings arrays, packages,
 * trust). When pi can't run, or answers with no skills at all (the
 * e2e stub does), a filesystem scan of the roots Phosphor knows about keeps the
 * page honest instead of empty — labelled `probe: 'scan'` so the UI can say
 * the list is approximate.
 *
 * Mutations only ever touch the two phosphor-writable roots
 * (`~/.pi/agent/skills`, `<ws>/.pi/skills`). Package dirs are npm-owned and
 * `pi update` would destroy edits; foreign harness dirs (`.claude/skills`)
 * are read-only here on purpose.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { composeSkillMd, validateSkillName, type SkillScope } from '@shared/skills'
import {
  forgetKnownSkillDir,
  isWritableSkillDir,
  registerKnownSkillDir,
  requireKnownPath,
  requireKnownSkillDir,
  SKILL_SIDECAR,
  skillRoots,
} from './skills/bundle'

export { installCatalogSkill, type InstallSkillOptions } from './skills/catalog-install'
export {
  confirmSkillImport,
  previewSkillImport,
  type ConfirmImportOptions,
} from './skills/archive-import'
export { resolveSkills, type SkillProbeOptions } from './skills/discovery'
export {
  buildSkillZip,
  LEGACY_SKILL_SIDECAR,
  readSkillFileEntry,
  SKILL_SIDECAR,
  skillRoots,
  registerKnownSkillDir as _registerKnownSkillDirForTest,
} from './skills/bundle'

export interface CreateSkillOptions {
  scope: SkillScope
  workspacePath?: string
  name: string
  description: string
  content: string
  draft: boolean
}

export async function createSkill(options: CreateSkillOptions): Promise<{ dir: string }> {
  const nameError = validateSkillName(options.name)
  if (nameError) throw new Error(nameError)
  const roots = skillRoots(options.workspacePath)
  const root = options.scope === 'project' ? roots.projectRoot : roots.userRoot
  if (!root) throw new Error('no workspace open for a project skill')
  const dir = join(root, options.name)
  if (existsSync(dir)) throw new Error(`a skill named "${options.name}" already exists there`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), composeSkillMd(options), 'utf8')
  registerKnownSkillDir(dir)
  return { dir }
}

export async function writeSkillFileEntry(
  dir: string,
  rel: string,
  content: string,
  workspacePath?: string,
): Promise<void> {
  if (!isWritableSkillDir(dir, workspacePath))
    throw new Error('this skill is read-only in Phosphor')
  const target = requireKnownPath(dir, rel)
  if (basename(target) === SKILL_SIDECAR) throw new Error('the provenance sidecar is not editable')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}

export async function deleteSkill(dir: string, workspacePath?: string): Promise<void> {
  const base = requireKnownSkillDir(dir)
  if (!isWritableSkillDir(base, workspacePath))
    throw new Error('this skill is read-only in Phosphor')
  await shell.trashItem(base)
  forgetKnownSkillDir(base)
}
