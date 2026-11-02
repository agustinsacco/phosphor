import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GLOBAL_INSTRUCTIONS_MAX_BYTES } from '@phosphor/shared/global-instructions'
import {
  appendGlobalInstructions,
  GlobalInstructionsError,
  globalInstructionsPath,
  readGlobalInstructions,
  writeGlobalInstructions,
} from './global-instructions'

const DESKTOP = { followLinks: true }
const HOST = { followLinks: false }
let root: string
let agentDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'global-instructions-'))
  agentDir = join(root, 'agent')
  mkdirSync(agentDir, { mode: 0o700 })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const failure = (run: () => unknown): GlobalInstructionsError => {
  try {
    run()
  } catch (error) {
    if (error instanceof GlobalInstructionsError) return error
    throw error
  }
  throw new Error('expected a failure')
}

describe('which file', () => {
  it('follows pi’s order, and names AGENTS.md when there is none', () => {
    expect(globalInstructionsPath(agentDir)).toEqual({
      path: join(agentDir, 'AGENTS.md'),
      exists: false,
    })
    writeFileSync(join(agentDir, 'CLAUDE.md'), 'claude')
    expect(globalInstructionsPath(agentDir).path).toBe(join(agentDir, 'CLAUDE.md'))
    writeFileSync(join(agentDir, 'AGENTS.md'), 'agents')
    expect(globalInstructionsPath(agentDir).path).toBe(join(agentDir, 'AGENTS.md'))
    writeFileSync(join(agentDir, 'AGENTS.override.md'), 'override')
    expect(readGlobalInstructions(agentDir, HOST)).toMatchObject({
      path: join(agentDir, 'AGENTS.override.md'),
      content: 'override',
      exists: true,
    })
  })

  it('saves the CLAUDE.md pi loads rather than creating an AGENTS.md that would replace it', () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), 'old')
    const read = readGlobalInstructions(agentDir, HOST)
    writeGlobalInstructions(agentDir, 'new', read.revision, HOST)
    expect(readFileSync(join(agentDir, 'CLAUDE.md'), 'utf8')).toBe('new')
    expect(readdirSync(agentDir)).toEqual(['CLAUDE.md'])
  })
})

describe('saving', () => {
  it('creates the file, then saves only over the revision it read', () => {
    const empty = readGlobalInstructions(agentDir, HOST)
    const saved = writeGlobalInstructions(agentDir, '# Mine\n', empty.revision, HOST)
    expect(saved).toMatchObject({ content: '# Mine\n', exists: true })
    expect(saved.revision).not.toBe(empty.revision)
    expect(statSync(saved.path).mode & 0o777).toBe(0o644)
    writeFileSync(saved.path, 'edited in a terminal\n')
    const stale = failure(() => writeGlobalInstructions(agentDir, 'lost', saved.revision, HOST))
    expect(stale.code).toBe('conflict')
    expect(readFileSync(saved.path, 'utf8')).toBe('edited in a terminal\n')
    expect(readdirSync(agentDir)).toEqual(['AGENTS.md'])
  })

  it('keeps the file’s mode and leaves no temporary file when the last check fails', () => {
    const path = join(agentDir, 'AGENTS.md')
    writeFileSync(path, 'a')
    chmodSync(path, 0o600)
    const read = readGlobalInstructions(agentDir, HOST)
    writeGlobalInstructions(agentDir, 'b', read.revision, HOST)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const next = readGlobalInstructions(agentDir, HOST)
    const revoked = failure(() =>
      writeGlobalInstructions(agentDir, 'c', next.revision, HOST, () => false),
    )
    expect(revoked.code).toBe('unsafe')
    expect(readFileSync(path, 'utf8')).toBe('b')
    expect(readdirSync(agentDir)).toEqual(['AGENTS.md'])
  })

  it('refuses text pi would not load as written', () => {
    const { revision } = readGlobalInstructions(agentDir, HOST)
    expect(failure(() => writeGlobalInstructions(agentDir, 'a\0b', revision, HOST)).code).toBe(
      'invalid',
    )
    const big = 'x'.repeat(GLOBAL_INSTRUCTIONS_MAX_BYTES + 1)
    expect(failure(() => writeGlobalInstructions(agentDir, big, revision, HOST)).code).toBe(
      'invalid',
    )
    writeFileSync(join(agentDir, 'AGENTS.md'), big)
    expect(failure(() => readGlobalInstructions(agentDir, HOST)).code).toBe('invalid')
  })
})

describe('links', () => {
  let target: string
  beforeEach(() => {
    target = join(root, 'dotfiles', 'AGENTS.md')
    mkdirSync(join(root, 'dotfiles'))
    writeFileSync(target, 'linked\n')
    symlinkSync(target, join(agentDir, 'AGENTS.md'))
  })

  it('on Desktop: reads through a link and saves into its target, so the link survives', () => {
    const read = readGlobalInstructions(agentDir, DESKTOP)
    expect(read.content).toBe('linked\n')
    writeGlobalInstructions(agentDir, 'saved\n', read.revision, DESKTOP)
    expect(lstatSync(join(agentDir, 'AGENTS.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('saved\n')
  })

  it('on a Host: refuses the link, reading or writing', () => {
    expect(failure(() => readGlobalInstructions(agentDir, HOST)).code).toBe('unsafe')
    const revision = readGlobalInstructions(agentDir, DESKTOP).revision
    expect(failure(() => writeGlobalInstructions(agentDir, 'x', revision, HOST)).code).toBe(
      'unsafe',
    )
    expect(readFileSync(target, 'utf8')).toBe('linked\n')
  })
})

describe('appending', () => {
  it('adds text after what is there, separated by a blank line', () => {
    expect(appendGlobalInstructions(agentDir, '  first  ', DESKTOP).content).toBe('first\n')
    expect(appendGlobalInstructions(agentDir, 'second', DESKTOP).content).toBe('first\n\nsecond\n')
  })
})
