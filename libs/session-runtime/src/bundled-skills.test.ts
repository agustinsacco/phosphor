import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { restoreArtifactSkill, seedBundledSkills, seedSkill } from './bundled-skills'

const seedArtifactSkill = (root: string, agentDir: string, restore = false) =>
  seedSkill(root, agentDir, 'visual-artifacts', restore)

const resources = resolve(import.meta.dirname, '../../pi-extensions')
let agent: string
beforeEach(() => {
  agent = mkdtempSync(join(tmpdir(), 'bundled-skills-'))
})
afterEach(() => rmSync(agent, { recursive: true, force: true }))

it('installs the complete bundled skill once, preserving edits, hiding and deletion', () => {
  const dir = seedArtifactSkill(resources, agent)
  const file = join(dir, 'SKILL.md')
  expect(readFileSync(file, 'utf8')).toBe(
    readFileSync(join(resources, 'skills/visual-artifacts/SKILL.md'), 'utf8'),
  )
  expect(readFileSync(join(dir, 'references/mermaid.md'), 'utf8')).toContain('sequenceDiagram')
  writeFileSync(
    file,
    '---\nname: visual-artifacts\ndisable-model-invocation: true\n---\nMy custom guidance',
  )
  seedArtifactSkill('/an-updated-app', agent)
  expect(readFileSync(file, 'utf8')).toContain('My custom guidance')
  seedArtifactSkill(resources, agent, true)
  expect(readFileSync(file, 'utf8')).toContain('My custom guidance')
  rmSync(dir, { recursive: true })
  seedArtifactSkill(resources, agent)
  expect(existsSync(dir)).toBe(false)
  seedArtifactSkill(resources, agent, true)
  expect(readFileSync(file, 'utf8')).toContain('Choose the medium')
})

it('does not overwrite an existing skill or a dangling symlink', () => {
  const target = join(agent, 'skills/visual-artifacts')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'SKILL.md'), 'User owned')
  seedArtifactSkill(resources, agent)
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('User owned')
  rmSync(target, { recursive: true })
  symlinkSync(join(agent, 'missing'), target, 'junction')
  seedArtifactSkill(resources, agent, true)
  expect(existsSync(join(agent, 'missing'))).toBe(false)
})

it('a missing packaged resource leaves no receipt or partial skill and can be retried', () => {
  expect(() => seedArtifactSkill('/missing-resources', agent)).toThrow('skill is missing')
  expect(existsSync(join(agent, 'skills/visual-artifacts'))).toBe(false)
  expect(readdirSync(join(agent, '.phosphor-bundled-skills'))).toEqual([])
  seedArtifactSkill(resources, agent)
  expect(existsSync(join(agent, 'skills/visual-artifacts/SKILL.md'))).toBe(true)
})

it('seeds every bundled skill, each with its own receipt, and keeps going past a missing one', () => {
  seedBundledSkills(resources, agent)
  expect(readFileSync(join(agent, 'skills/release-setup/SKILL.md'), 'utf8')).toContain(
    'name: release-setup',
  )
  expect(readdirSync(join(agent, '.phosphor-bundled-skills')).sort()).toEqual([
    'release-setup',
    'visual-artifacts',
  ])
  rmSync(join(agent, 'skills/release-setup'), { recursive: true })
  seedBundledSkills(resources, agent)
  expect(existsSync(join(agent, 'skills/release-setup'))).toBe(false)
  const partial = mkdtempSync(join(tmpdir(), 'bundled-resources-'))
  try {
    mkdirSync(join(partial, 'skills/release-setup'), { recursive: true })
    writeFileSync(join(partial, 'skills/release-setup/SKILL.md'), 'Release setup')
    const fresh = mkdtempSync(join(tmpdir(), 'bundled-skills-'))
    expect(() => seedBundledSkills(partial, fresh)).toThrow(
      'Bundled visual-artifacts skill is missing',
    )
    expect(readFileSync(join(fresh, 'skills/release-setup/SKILL.md'), 'utf8')).toBe('Release setup')
    rmSync(fresh, { recursive: true, force: true })
  } finally {
    rmSync(partial, { recursive: true, force: true })
  }
})

it('restores only the artifact skill, so a deleted release-setup stays deleted', () => {
  seedBundledSkills(resources, agent)
  rmSync(join(agent, 'skills/visual-artifacts'), { recursive: true })
  rmSync(join(agent, 'skills/release-setup'), { recursive: true })
  restoreArtifactSkill(resources, agent)
  expect(existsSync(join(agent, 'skills/visual-artifacts/SKILL.md'))).toBe(true)
  expect(existsSync(join(agent, 'skills/release-setup'))).toBe(false)
})
