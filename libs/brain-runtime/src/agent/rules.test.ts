import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BRAIN_AGENT_RULES, BRAIN_AGENT_RULES_V7, ensureBrainLane, readBrainRules } from './rules'

let root: string
beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'brain-rules-')))
})
afterEach(() => rm(root, { recursive: true, force: true }))

it('writes the default rules only while AGENTS.md is missing', async () => {
  const folder = join(root, 'brain', 'Brain')
  expect(await readBrainRules(folder)).toBeNull()
  await ensureBrainLane(folder)
  expect(await readBrainRules(folder)).toBe(BRAIN_AGENT_RULES)
  await writeFile(join(folder, 'AGENTS.md'), '# Owner rules')
  await ensureBrainLane(folder)
  expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toBe('# Owner rules')
  expect(BRAIN_AGENT_RULES.split('\n')[0]).toBe('# Brain Agent')
})

it('upgrades only the exact v7 rules', async () => {
  expect(BRAIN_AGENT_RULES_V7).toBeTypeOf('string')
  for (const suffix of ['', '\n']) {
    await writeFile(join(root, 'AGENTS.md'), BRAIN_AGENT_RULES_V7 + suffix)
    await ensureBrainLane(root)
    expect(await readBrainRules(root)).toBe(
      suffix ? BRAIN_AGENT_RULES_V7 + suffix : BRAIN_AGENT_RULES,
    )
  }
  expect(BRAIN_AGENT_RULES).toContain('## Links')
})
