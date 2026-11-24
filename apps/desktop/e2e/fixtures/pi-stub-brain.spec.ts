import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { extractPrompt, EXTRACTION_SYSTEM } from '@phosphor/brain-runtime/stage-prompts/extract'
import { identityPrompt, IDENTITY_SYSTEM } from '@phosphor/brain-runtime/stage-prompts/identity'
import { reconcilePrompt, RECONCILE_SYSTEM } from '@phosphor/brain-runtime/stage-prompts/reconcile'
import { repairPrompt } from '@phosphor/brain-runtime/stage-call'
import { makeWindow } from '@phosphor/brain-runtime/windows'
import { parseStageExtraction } from '@phosphor/brain-runtime/stage-parse'
import { LINKS_SYSTEM, linksPrompt } from '@phosphor/brain-runtime/stage-prompts/links'
import { linksInput } from '@phosphor/brain-runtime/stage-links-input'
import { parseStageLinks } from '@phosphor/brain-runtime/stage-links-parse'
import { rebuildPrompt } from '@phosphor/brain-runtime/stage-input'
import type { StageExtraction, Registry } from '@phosphor/brain-runtime/stage-types'
import { scratchDir } from './scratch'

const stub = resolve(import.meta.dirname, 'pi-stub.cjs')
const window = makeWindow([
  {
    entryId: 'ignored',
    role: 'toolResult',
    label: 'Tool output',
    observedAt: 0,
    text: 'Tom Lee owns Imaginary.',
  },
  {
    entryId: 'source',
    role: 'user',
    label: 'You',
    observedAt: 0,
    text: 'Rina Okafor owns Harbor ledger.',
  },
  {
    entryId: 'agent',
    role: 'assistant',
    label: 'Agent',
    observedAt: 0,
    text: 'Harbor ledger is part of Harbor.',
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

async function stubLinks(extraction: StageExtraction, registry: Registry = [], source = window) {
  const input = linksInput(extraction, registry, source, source.segments)
  const result = await call(LINKS_SYSTEM, rebuildPrompt('links', { links: input }, source.segments))
  expect(result.code).toBe(0)
  return parseStageLinks(result.message.content[0].text, source, extraction, input).links
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
  const links = await stubLinks(answer)
  expect([answer.claims[0]!.links[0], ...links.map(({ claim: _claim, ...link }) => link)]).toEqual([
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
      segment: 's3',
      quote: answer.claims[1]!.text,
    },
  ])
  expect(answer.parents).toEqual([
    { entity: 'n2', status: 'not_stated', claim: null },
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

test('Brain stub repairs extraction using the original stage', async () => {
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

test('Brain stub fails both attempts of the first extract, then succeeds from the same marker directory', async () => {
  const directory = await scratchDir('brain-stub-failure-')
  const env = { PHOSPHOR_STUB_BRAIN_FAIL_ONCE: join(directory, 'fail') }
  try {
    await mkdir(env.PHOSPHOR_STUB_BRAIN_FAIL_ONCE)
    const first = await call(EXTRACTION_SYSTEM, extractPrompt(window, []), { env })
    expect(first.code).not.toBe(0)
    expect(first.message.stopReason).toBe('error')
    const retry = await call(EXTRACTION_SYSTEM, extractPrompt(window, []), { env })
    expect(retry.code).not.toBe(0)
    expect(
      await readFile(join(env.PHOSPHOR_STUB_BRAIN_FAIL_ONCE, 'failed-attempt-2'), 'utf8'),
    ).toBe('extract\n')
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
  expect(answer.claims[0]!.links).toEqual([])
  expect(await stubLinks(answer, registry, source)).toEqual([
    {
      claim: 'c1',
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

test('Brain stub gets the parent link only from the small links call, including repair', async () => {
  const extracted = await call(EXTRACTION_SYSTEM, extractPrompt(window, []))
  const part = parseStageExtraction(extracted.message.content[0].text, window)
  expect(part.claims[1]!.links).toEqual([])
  const prompt = linksPrompt(
    part.entities,
    part.claims.map((c) => ({
      ...c,
      excerpts: c.quotes.map((q) => ({ segment: q.segment, text: q.quote })),
    })),
  )
  const normal = await call(LINKS_SYSTEM, prompt)
  expect(normal.code).toBe(0)
  expect(JSON.parse(normal.message.content[0].text).links).toEqual([
    {
      claim: 'c2',
      subject: 'n2',
      predicate: 'part_of',
      object: 'n3',
      segment: 's3',
      quote: 'Harbor ledger is part of Harbor.',
    },
  ])
  const repaired = await call(LINKS_SYSTEM, repairPrompt(prompt, '{}', 'Expected links'))
  expect(repaired.message.content).toEqual(normal.message.content)
})

test('stub reader models a handover and leaves joint work for Brain Agent', async () => {
  const text = ['Rina Okafor owns Harbor ledger.', 'Harbor ledger is part of Harbor.',
    'Tom Lee took over Harbor ledger from Rina Okafor.', 'Rina Okafor and Mara Voss reviewed the Harbor invoices.',
    'Rina Okafor and Mara Voss planned the Kestrel rollout.'].join('\n')
  const result=await call(EXTRACTION_SYSTEM,extractPrompt(makeWindow([{entryId:'ledger',role:'user',label:'You',observedAt:0,text}]),[]))
  const raw=JSON.parse(result.message.content[0].text)
  expect(raw.claims).toHaveLength(5)
  const id=(name:string)=>raw.entities.find((e:{label:string})=>e.label===name).ref
  expect(raw.claims[2].links).toEqual([expect.objectContaining({subject:id('Tom Lee'),predicate:'took_over_from',label:'took over Harbor ledger from',object:id('Rina Okafor')})])
  expect(raw.claims[2].mentions).toContain(id('Harbor ledger'))
  for(const claim of raw.claims.slice(3)) expect(claim).toMatchObject({importance:1,links:[],mentions:[id('Rina Okafor'),id('Mara Voss')]})
})
