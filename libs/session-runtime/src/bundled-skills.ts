import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** Shipped defaults become ordinary, user-owned pi skills. */
export const ARTIFACT_SKILL = 'visual-artifacts'
export const BUNDLED_SKILLS = [ARTIFACT_SKILL, 'release-setup'] as const

/**
 * Seed every bundled skill. One missing bundle does not keep the others out;
 * the first failure is thrown once all have been tried.
 */
export function seedBundledSkills(resourceRoot: string, agentDir: string, restore = false): void {
  const failures: unknown[] = []
  for (const name of BUNDLED_SKILLS) {
    try {
      seedSkill(resourceRoot, agentDir, name, restore)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw failures[0]
}

/**
 * Seed once per pi configuration, not per app version. The receipt is outside
 * the skill: deleting the skill must not cause its resurrection on restart.
 * Existing bundles (including symlinks) always win. Restoring is explicit and
 * only fills an absent bundle; it never overwrites somebody's edits.
 */
export function seedSkill(
  resourceRoot: string,
  agentDir: string,
  name: (typeof BUNDLED_SKILLS)[number],
  restore = false,
): string {
  const state = join(agentDir, '.phosphor-bundled-skills')
  const receipt = join(state, name)
  const target = join(agentDir, 'skills', name)
  if (!restore && existsSync(receipt)) return target
  mkdirSync(state, { recursive: true })
  const present = (): boolean => {
    try {
      lstatSync(target)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return false
    }
  }
  if (!present()) {
    const staging = mkdtempSync(join(state, 'install-'))
    try {
      const source = join(resourceRoot, 'skills', name)
      if (!existsSync(join(source, 'SKILL.md'))) throw new Error(`Bundled ${name} skill is missing`)
      const prepared = join(staging, name)
      cpSync(source, prepared, { recursive: true, errorOnExist: true, force: false })
      mkdirSync(join(agentDir, 'skills'), { recursive: true })
      // Never expose half a bundle to pi's resource discovery.
      if (!present()) {
        try {
          renameSync(prepared, target)
        } catch (error) {
          // A concurrent installer may have won. Do not replace its bundle.
          if (!present()) throw error
        }
      }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  writeFileSync(receipt, 'Installed once. Edits and removal are user-owned.\n')
  return target
}
