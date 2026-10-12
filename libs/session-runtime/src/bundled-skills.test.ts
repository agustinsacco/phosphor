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
import { seedArtifactSkill } from './bundled-skills'

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

it('Desktop packaging ships the skill and the Host build copies the same resource tree', () => {
  const repo = resolve(import.meta.dirname, '../../..')
  expect(readFileSync(join(repo, 'apps/desktop/electron-builder.yml'), 'utf8')).toContain(
    'from: ../../libs/pi-extensions/skills',
  )
  expect(readFileSync(join(repo, 'apps/host/scripts/build.mjs'), 'utf8')).toContain(
    "join(ROOT, 'libs/pi-extensions/skills')",
  )
})
