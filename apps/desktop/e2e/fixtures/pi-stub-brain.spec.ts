import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { extractPrompt, EXTRACTION_SYSTEM } from '@phosphor/brain-runtime/stage-prompts/extract'
import { identityPrompt, IDENTITY_SYSTEM } from '@phosphor/brain-runtime/stage-prompts/identity'
import { parentsPrompt, PARENTS_SYSTEM } from '@phosphor/brain-runtime/stage-prompts/parents'
import { reconcilePrompt, RECONCILE_SYSTEM } from '@phosphor/brain-runtime/stage-prompts/reconcile'
import { repairPrompt } from '@phosphor/brain-runtime/stage-call'
import { makeWindow } from '@phosphor/brain-runtime/windows'
import { parseStageExtraction } from '@phosphor/brain-runtime/stage-parse'
import { scratchDir } from './scratch'

const stub = resolve(import.meta.dirname, 'pi-stub.cjs')
const window = makeWindow([
  {
    entryId: 'ignored',
    role: 'assistant',
    label: 'Assistant',
    observedAt: 0,
    text: 'Tom Lee owns Imaginary.',
  },
  {
    entryId: 'source',
    role: 'user',
    label: 'You',
    observedAt: 0,
    text: 'Rina Okafor owns Harbor ledger. Harbor ledger is part of Harbor.',
  },
])

async function call(
  system: string,
  prompt: string,
  options: {
    env?: Record<string, string>
    noTools?: boolean
    noGuard?: boolean
  } = {},
) {
  const directory = await scratchDir('brain-stub-call-')
  try {
    const systemPath = join(directory, 'system.md')
    await writeFile(systemPath, system)
    const args = [
      '-p',
      '--mode',
      'json',
      '--no-session',
      '--system-prompt',
      systemPath,
      ...(options.noTools ? [] : ['--no-tools']),
      ...(options.noGuard ? [] : ['-e', join(directory, 'brain-fork-guard.mjs')]),
    ]
    const result = spawnSync(
      process.execPath,
      options.noGuard
        ? [
            '-e',
            `require(${JSON.stringify(join(import.meta.dirname, 'pi-stub-brain.cjs'))}).runBrain(process.argv.slice(1))`,
            '--',
            ...args,
          ]
        : [stub, ...args],
      {
        input: prompt,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, ...options.env, PI_CODING_AGENT_DIR: directory },
      },
    )
    expect(result.error).toBeUndefined()
    const event = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'message_end')
    return { code: result.status, message: event.message }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('Brain stub reads stdin and system file, keeps handles and directed owner/parent quotes', async () => {
  const result = await call(EXTRACTION_SYSTEM, extractPrompt(window, []))
  expect(result.code).toBe(0)
  const answer = parseStageExtraction(result.message.content[0].text, window)
  expect(answer.entities.map((e) => e.label)).toEqual(['Rina Okafor', 'Harbor ledger', 'Harbor'])
  expect(answer.claims.map((c) => c.text)).toEqual([
    'Rina Okafor owns Harbor ledger.',
    'Harbor ledger is part of Harbor.',
  ])
  expect(answer.claims.map((c) => c.links[0])).toEqual([
    {
      subject: 'n1',
      predicate: 'owns',
      object: 'n2',
      segment: 's2',
      quote: answer.claims[0]!.text,
    },
    {
      subject: 'n2',
      predicate: 'part_of',
      object: 'n3',
      segment: 's2',
      quote: answer.claims[1]!.text,
    },
  ])
  expect(answer.parents).toEqual([
    { entity: 'n2', status: 'stated', claim: 'c2' },
    { entity: 'n3', status: 'not_stated', claim: null },
  ])
})

test('Brain stub chooses only offered identity and reconciliation handles', async () => {
  const identity = await call(
    IDENTITY_SYSTEM,
    identityPrompt([
      {
        entity: { ref: 'w1:n1', label: 'Rina Okafor' },
        candidates: [
          { handle: 'K1', label: 'Tom Lee' },
          { handle: 'K2', label: ' RINA  OKAFOR ' },
        ],
      },
      {
        entity: { ref: 'w1:n2', label: 'Harbor' },
        candidates: [{ handle: 'K1', label: 'Ledger' }],
      },
    ]),
  )
  expect(JSON.parse(identity.message.content[0].text).decisions).toMatchObject([
    { ref: 'w1:n1', action: 'reuse', candidate: 'K2' },
    { ref: 'w1:n2', action: 'new', candidate: null },
  ])
  const reconcile = await call(
    RECONCILE_SYSTEM,
    reconcilePrompt([
      {
        claim: { ref: 'w1:c1', memory: { summary: 'Rina owns Ledger.' } },
        candidates: [
          { handle: 'M1', summary: 'Tom owns Ledger.' },
          { handle: 'M2', summary: 'Rina owns Ledger.' },
        ],
      },
      { claim: { ref: 'w1:c2', memory: { summary: 'Ledger is part of Harbor.' } }, candidates: [] },
    ]),
  )
  expect(JSON.parse(reconcile.message.content[0].text).decisions).toMatchObject([
    { ref: 'w1:c1', action: 'confirm', target: 'M2' },
    { ref: 'w1:c2', action: 'add', target: null },
  ])
})

test('Brain stub leaves parents unstated and repairs using the original stage', async () => {
  const parents = await call(
    PARENTS_SYSTEM,
    parentsPrompt([{ ref: 'r1', label: 'Harbor' }], [], ''),
  )
  expect(JSON.parse(parents.message.content[0].text)).toEqual({
    entities: [],
    claims: [],
    parents: [{ entity: 'r1', status: 'not_stated', claim: null }],
  })
  const original = extractPrompt(window, [])
  const repaired = await call(EXTRACTION_SYSTEM, repairPrompt(original, '{}', 'Missing claims'))
  const normal = await call(EXTRACTION_SYSTEM, original)
  expect(repaired.message.content).toEqual(normal.message.content)
})

test('Brain stub refuses missing tools guard or guard extension', async () => {
  for (const options of [{ noTools: true }, { noGuard: true }]) {
    const result = await call(EXTRACTION_SYSTEM, extractPrompt(window, []), options)
    expect(result.code).not.toBe(0)
    expect(result.message.stopReason).toBe('error')
    expect(result.message.content[0].text).toBe('')
    expect(result.message.errorMessage).toContain('guard')
  }
})

test('Brain stub fails the first extract once, then succeeds from the same marker directory', async () => {
  const directory = await scratchDir('brain-stub-failure-')
  const env = { PHOSPHOR_STUB_BRAIN_FAIL_ONCE: join(directory, 'fail') }
  try {
    await mkdir(env.PHOSPHOR_STUB_BRAIN_FAIL_ONCE)
    const first = await call(EXTRACTION_SYSTEM, extractPrompt(window, []), { env })
    expect(first.code).not.toBe(0)
    expect(first.message.stopReason).toBe('error')
    expect(await readFile(join(env.PHOSPHOR_STUB_BRAIN_FAIL_ONCE, 'failed-once'), 'utf8')).toBe(
      'extract\n',
    )
    const next = await call(EXTRACTION_SYSTEM, extractPrompt(window, []), { env })
    expect(next.code).toBe(0)
    expect(parseStageExtraction(next.message.content[0].text, window).claims).toHaveLength(2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Brain stub reuses registry handles for lower-case component sentences', async () => {
  const source = makeWindow([
    {
      entryId: 'source',
      role: 'user',
      label: 'You',
      observedAt: 0,
      text: 'ledger export is part of Harbor.',
    },
  ])
  const registry = [
    {
      ref: 'r1',
      label: 'ledger export',
      kind: 'component' as const,
      aliases: [],
      description: '',
      keys: [],
    },
    {
      ref: 'r2',
      label: 'Harbor',
      kind: 'project' as const,
      aliases: [],
      description: '',
      keys: [],
    },
  ]
  const result = await call(EXTRACTION_SYSTEM, extractPrompt(source, registry))
  const answer = parseStageExtraction(result.message.content[0].text, source, registry)
  expect(answer.entities).toEqual([])
  expect(answer.claims).toHaveLength(1)
  expect(answer.claims[0]!.links).toEqual([
    {
      subject: 'r1',
      predicate: 'part_of',
      object: 'r2',
      segment: 's1',
      quote: source.segments[0]!.text,
    },
  ])
})

for (const [stage, system, prompt] of [
  [
    'identity',
    IDENTITY_SYSTEM,
    identityPrompt([{ entity: { ref: 'w1:n1', label: 'Harbor' }, candidates: [] }]),
  ],
  ['parents', PARENTS_SYSTEM, parentsPrompt([{ ref: 'r1', label: 'Harbor' }], [], '')],
  [
    'reconcile',
    RECONCILE_SYSTEM,
    reconcilePrompt([
      { claim: { ref: 'w1:c1', memory: { summary: 'Harbor exists.' } }, candidates: [] },
    ]),
  ],
]) {
  test(`Brain stub repairs ${stage} with its original system prompt`, async () => {
    const normal = await call(system!, prompt!)
    const repaired = await call(system!, repairPrompt(prompt!, '{}', 'Missing decisions'))
    expect(repaired.code).toBe(0)
    expect(repaired.message.content).toEqual(normal.message.content)
  })
}
