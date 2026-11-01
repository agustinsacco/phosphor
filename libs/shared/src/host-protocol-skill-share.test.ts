import { describe, expect, it } from 'vitest'
import { parseMachineParams } from './host-protocol-machine'
import {
  base64Bytes,
  bundleBytes,
  parseSkillBundle,
  parseSkillInstallParams,
  parseSkillInstallResult,
  SKILL_SHARE_LIMITS,
} from './host-protocol-skill-share'

const b64 = (text: string) => btoa(text)
const bundle = (files: { path: string; data: string }[], name = 'demo') => ({ name, files })
const skill = { path: 'SKILL.md', data: b64('---\nname: demo\n---\n') }

describe('skill bundles', () => {
  it('measures canonical base64 and rejects anything else', () => {
    expect(base64Bytes('')).toBe(0)
    expect(base64Bytes(b64('a'))).toBe(1)
    expect(base64Bytes(b64('ab'))).toBe(2)
    expect(base64Bytes(b64('abc'))).toBe(3)
    for (const bad of ['abc', 'ab=c', 'a b=', '****', 'YQ===']) expect(base64Bytes(bad)).toBeNull()
  })

  it('accepts a bundle with SKILL.md and nested files', () => {
    const value = bundle([skill, { path: 'scripts/run.sh', data: b64('echo hi') }])
    expect(parseSkillBundle(value)).toEqual(value)
    expect(bundleBytes(value)).toBe(atob(skill.data).length + 7)
  })

  it('rejects names, paths and shapes that could escape or shadow the bundle', () => {
    const bad: unknown[] = [
      null,
      bundle([]),
      bundle([skill], 'Demo'),
      bundle([skill], '../demo'),
      bundle([{ path: 'README.md', data: b64('x') }]),
      bundle([skill, skill]),
      bundle([skill, { path: '../x', data: '' }]),
      bundle([skill, { path: '/abs', data: '' }]),
      bundle([skill, { path: 'a\\b', data: '' }]),
      bundle([skill, { path: '.git/config', data: '' }]),
      bundle([skill, { path: '.hidden/file', data: '' }]),
      bundle([skill, { path: '.phosphor-skill.json', data: '' }]),
      bundle([skill, { path: 'a', data: '' }, { path: 'a/b', data: '' }]),
      bundle([skill, { path: 'x', data: 'not base64!' }]),
      bundle([{ ...skill, extra: true } as never]),
      { ...bundle([skill]), extra: 1 },
    ]
    for (const value of bad) expect(parseSkillBundle(value)).toBeNull()
    expect(parseSkillBundle(bundle([skill, { path: '.env.example', data: '' }]))).not.toBeNull()
  })

  it('enforces the file count, per-file and total byte limits', () => {
    const many = Array.from({ length: SKILL_SHARE_LIMITS.files }, (_, i) => ({
      path: `f${i}`,
      data: '',
    }))
    expect(parseSkillBundle(bundle([skill, ...many.slice(1)]))).not.toBeNull()
    expect(parseSkillBundle(bundle([skill, ...many]))).toBeNull()
    const chars = (bytes: number) => 'A'.repeat(Math.floor(bytes / 3) * 4)
    const big = chars(SKILL_SHARE_LIMITS.fileBytes + 3)
    expect(parseSkillBundle(bundle([skill, { path: 'big', data: big }]))).toBeNull()
    const half = chars(1.5 * 1024 * 1024)
    const files = [skill, { path: 'a', data: half }, { path: 'b', data: half }]
    expect(parseSkillBundle(bundle(files))).not.toBeNull()
    expect(parseSkillBundle(bundle([...files, { path: 'c', data: half }]))).toBeNull()
  })
})

describe('skill share calls', () => {
  it('parses install params and results exactly', () => {
    expect(parseSkillInstallParams({ bundle: bundle([skill]) })).toEqual({
      bundle: bundle([skill]),
      overwrite: false,
    })
    expect(parseSkillInstallParams({ bundle: bundle([skill]), overwrite: true })?.overwrite).toBe(
      true,
    )
    expect(parseSkillInstallParams({ bundle: bundle([skill]), overwrite: 'yes' })).toBeNull()
    expect(parseSkillInstallParams({ bundle: bundle([skill]), root: '/tmp' })).toBeNull()
    expect(parseSkillInstallResult({ status: 'installed', replaced: false })).toEqual({
      status: 'installed',
      replaced: false,
    })
    expect(parseSkillInstallResult({ status: 'conflict', replaceable: true })).toEqual({
      status: 'conflict',
      replaceable: true,
    })
    expect(parseSkillInstallResult({ status: 'conflict' })).toBeNull()
    expect(parseSkillInstallResult({ status: 'installed', replaced: 1 })).toBeNull()
  })

  it('accepts skills.export with a canonical name only', () => {
    expect(parseMachineParams('skills.export', { name: 'demo' })).toEqual({ name: 'demo' })
    expect(parseMachineParams('skills.export', {})).toBeNull()
    expect(parseMachineParams('skills.export', { name: 'Demo' })).toBeNull()
    expect(parseMachineParams('skills.export', { name: 'demo', file: 'SKILL.md' })).toBeNull()
  })
})
