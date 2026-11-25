import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrainCuratorClient } from '@phosphor/brain-client/curator-client'
import { BRAIN_CURATOR_METHODS, type BrainAgentWrite } from '@phosphor/shared/brain-agent'
import {
  OWNERSHIP_DETAIL,
  RINA_SUGGESTION,
  RINA_VIEW,
  WAITING,
} from '../../brain-client/src/__fixtures__/curator'
import { HARBOR_RECALL } from '../../brain-client/src/__fixtures__/recall'
import brainCuratorExtension, { registerCuratorReads, registerRulesReload } from './brain-curator'
import { registerCuratorWrites } from './brain-curator-writes'
import type { ToolDefinition } from './pi-api'

type Tool = ToolDefinition<Record<string, unknown>, unknown, { status: string }>
const DONE: BrainAgentWrite = { status: 'done', message: 'Saved.', operationId: 'op-7' }
const RESULTS: Record<string, unknown> = {
  waiting: WAITING,
  suggestion: RINA_SUGGESTION,
  search: HARBOR_RECALL,
  entity: RINA_VIEW,
  memory: OWNERSHIP_DETAIL,
}

function setup(results: Record<string, unknown> = RESULTS) {
  const tools = new Map<string, Tool>()
  const call = vi.fn(
    async (method: string, _params?: unknown, _signal?: AbortSignal) => results[method] ?? DONE,
  )
  const client = { call } as unknown as BrainCuratorClient
  const pi = {
    registerTool: (tool: unknown) => tools.set((tool as Tool).name, tool as Tool),
    on: vi.fn(),
  }
  registerCuratorReads(pi, client)
  registerCuratorWrites(pi, client)
  const run = async (name: string, params: Record<string, unknown>) => {
    const result = await tools.get(name)!.execute('id', params, undefined, undefined, {})
    return { text: result.content[0]!.text, status: result.details.status }
  }
  return { tools, call, run }
}

afterEach(() => {
  vi.unstubAllEnvs()
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('phosphor/brain-connection/v1')]
})

describe('the bridge connection', () => {
  it('leaves no token or endpoint for a bash child of the lane, and survives a reload', async () => {
    vi.stubEnv('PHOSPHOR_BRAIN_ENDPOINT', '/tmp/kestrel-brain.sock')
    vi.stubEnv('PHOSPHOR_BRAIN_TOKEN', 'kestrel-curator-token')
    const pi = { registerTool: vi.fn(), on: vi.fn() }
    brainCuratorExtension(pi)
    expect(pi.registerTool).toHaveBeenCalledTimes(11)
    const child = spawnSync(
      'sh',
      ['-c', 'printf "%s|%s" "$PHOSPHOR_BRAIN_TOKEN" "$PHOSPHOR_BRAIN_ENDPOINT"'],
      { encoding: 'utf8' },
    )
    expect(child.stdout).toBe('|')
    // pi reloads an extension by evaluating its module again, in the same process.
    vi.resetModules()
    const { default: reloaded } = await import('./brain-curator')
    const again = { registerTool: vi.fn(), on: vi.fn() }
    reloaded(again)
    expect(again.registerTool).toHaveBeenCalledTimes(11)
  })
})

describe('brain-curator tools', () => {
  it('registers Brain Agent’s eleven tools and never brain_flag', () => {
    expect([...setup().tools.keys()].sort()).toEqual(
      BRAIN_CURATOR_METHODS.map((m) => 'brain_' + m).sort(),
    )
    expect([...setup().tools.keys()]).toEqual([
      'brain_waiting',
      'brain_suggestion',
      'brain_search',
      'brain_entity',
      'brain_memory',
      'brain_relate',
      'brain_resolve',
      'brain_edit',
      'brain_correct',
      'brain_erase',
      'brain_undo',
    ])
  })

  it('registers only the rules reload without a connection', () => {
    vi.stubEnv('PHOSPHOR_BRAIN_ENDPOINT', '')
    vi.stubEnv('PHOSPHOR_BRAIN_TOKEN', '')
    const pi = { registerTool: vi.fn(), on: vi.fn() }
    brainCuratorExtension(pi)
    expect(pi.registerTool).not.toHaveBeenCalled()
    expect(pi.on.mock.calls.map(([event]) => event)).toEqual(['context_with_system'])
  })

  it('gives every tool a required parameter, so a call with no arguments still validates', () => {
    const tools = [...setup().tools.values()]
    const optionalOnly = tools.filter(
      (tool) => !(tool.parameters as { required?: string[] }).required?.length,
    )
    expect(optionalOnly.map((tool) => tool.name)).toEqual(['brain_search'])
    expect(tools.find((tool) => tool.name === 'brain_suggestion')!.description).toMatch(
      /group.*unlinked pair/,
    )
    expect(tools.find((tool) => tool.name === 'brain_waiting')!.description).toContain('60')
  })

  it('takes strict parameters a model can fill first time', () => {
    for (const tool of setup().tools.values()) {
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false })
      expect(tool.description.length).toBeGreaterThan(60)
    }
  })

  it('formats each read result with the ids the next call needs', async () => {
    const { call, run } = setup()
    expect((await run('brain_waiting', { limit: 60 })).text).toContain('- sugg-rina · Rina Okafor')
    expect((await run('brain_suggestion', { suggestionId: 'sugg-rina' })).text).toContain(
      'Allowed: merge, keep, unname.',
    )
    expect((await run('brain_search', { query: 'Harbor' })).text).toContain('memory ownership')
    expect((await run('brain_entity', { entityId: 'rina' })).text).toContain('Entity rina.')
    expect((await run('brain_memory', { memoryId: 'ownership' })).text).toContain('Quotes:')
    expect(call.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ['waiting', { limit: 60 }],
      ['suggestion', { suggestionId: 'sugg-rina' }],
      ['search', { query: 'Harbor' }],
      ['entity', { entityId: 'rina' }],
      ['memory', { memoryId: 'ownership' }],
    ])
  })

  it('lets a client refusal reach the model as the tool’s error', async () => {
    const { call, run } = setup()
    call.mockRejectedValueOnce(new Error('Brain memoryId needs 1 to 200 characters.'))
    await expect(run('brain_memory', { memoryId: '' })).rejects.toThrow(
      'Brain memoryId needs 1 to 200 characters.',
    )
  })
})

describe('curator writes', () => {
  it('turns flat resolve parameters into the action and names a missing field', async () => {
    const { call, run } = setup()
    await run('brain_resolve', {
      suggestionId: 'sugg-rina',
      action: 'merge',
      survivorId: 'rina',
      reason: 'Same Slack account.',
    })
    await run('brain_resolve', { suggestionId: 's2', action: 'keep', reason: 'Both hold.' })
    expect(call.mock.calls.map(([, params]) => params)).toEqual([
      {
        suggestionId: 'sugg-rina',
        action: { kind: 'merge', survivorId: 'rina' },
        reason: 'Same Slack account.',
      },
      { suggestionId: 's2', action: { kind: 'keep' }, reason: 'Both hold.' },
    ])
    expect(await run('brain_resolve', { suggestionId: 's', action: 'fold', reason: 'r' })).toEqual({
      text: 'fold needs survivorId: the id of the record to keep.',
      status: 'refused',
    })
    expect(
      (
        await run('brain_resolve', {
          suggestionId: 's',
          action: 'unname',
          name: 'Rina',
          reason: 'r',
        })
      ).text,
    ).toBe('unname needs entityId and name: the record that loses the name, and the name.')
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('turns flat edit parameters into each edit', async () => {
    const { call, run } = setup()
    const reason = 'Different teams.'
    await run('brain_edit', { kind: 'merge', sourceId: 'rina-2', targetId: 'rina', reason })
    await run('brain_edit', { kind: 'describe', entityId: 'rina', description: 'Billing', reason })
    await run('brain_edit', {
      kind: 'split',
      entityId: 'rina',
      memoryIds: ['m1'],
      label: 'Mara Voss',
      entityKind: 'person',
      reason,
    })
    await run('brain_edit', { kind: 'removeName', entityId: 'rina', name: 'Rina', reason })
    expect(call.mock.calls.map(([, params]) => (params as { edit: unknown }).edit)).toEqual([
      { kind: 'merge', sourceId: 'rina-2', targetId: 'rina' },
      { kind: 'describe', entityId: 'rina', description: 'Billing' },
      {
        kind: 'split',
        entityId: 'rina',
        memoryIds: ['m1'],
        label: 'Mara Voss',
        entityKind: 'person',
      },
      { kind: 'removeName', entityId: 'rina', name: 'Rina' },
    ])
    expect((await run('brain_edit', { kind: 'split', entityId: 'rina', reason })).text).toBe(
      'split needs memoryIds, label and entityKind for the new record.',
    )
  })

  it('erases with a reason that must not quote the memory, and reports the engine’s answers', async () => {
    const { tools, call, run } = setup()
    const erase = tools.get('brain_erase')!
    expect(erase.description).toContain('the reason must not quote or restate the memory')
    expect(erase.description).toContain('At most 25 erasures an hour')
    const refused = 'Give a reason without quoting the memory; nothing changed.'
    call.mockResolvedValueOnce({ status: 'refused', message: refused, operationId: null })
    expect(
      await run('brain_erase', { memoryId: 'ownership', reason: 'Owns Harbor billing.' }),
    ).toEqual({
      text: `Refused, nothing changed: ${refused}`,
      status: 'refused',
    })
    call.mockResolvedValueOnce({ status: 'limit', message: 'Cap reached.', operationId: null })
    expect((await run('brain_erase', { memoryId: 'm', reason: 'Superseded.' })).status).toBe(
      'limit',
    )
    call.mockResolvedValueOnce({
      status: 'done',
      message: 'Erased. This is final: only your reason is kept.',
      operationId: null,
    })
    expect((await run('brain_erase', { memoryId: 'm', reason: 'Superseded.' })).text).toBe(
      'Done. Erased. This is final: only your reason is kept.',
    )
  })

  it('passes corrections and undo through unchanged', async () => {
    const { call, run } = setup()
    const correction = {
      memoryId: 'ownership',
      summary: 'Tom Lee owns Harbor billing.',
      source: 'Linear HAR-4',
      quote: 'Tom now owns billing',
      reason: 'Linear shows the handover.',
    }
    await run('brain_correct', correction)
    await run('brain_undo', { operationId: 'op-7', reason: 'Merged the wrong Rina.' })
    expect(call.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ['correct', correction],
      ['undo', { operationId: 'op-7', reason: 'Merged the wrong Rina.' }],
    ])
  })
})

describe('rules reload', () => {
  let folder: string
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'brain-lane-'))
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  const block = (path: string, content: string) =>
    `<project_instructions path="${path}">\n${content}\n</project_instructions>`
  const section = (...blocks: string[]) =>
    `<project_context>\n${['Project-specific instructions and guidelines:', ...blocks].join('\n\n')}\n</project_context>`
  const GLOBAL = block('/home/u/.pi/agent/AGENTS.md', 'Global')

  function hook(argv: readonly string[] = []) {
    const handlers: ((event: unknown, ctx: unknown) => unknown)[] = []
    registerRulesReload({ on: (_event, handler) => handlers.push(handler) }, folder, argv)
    return (projectContext: string) => {
      const messages = [{ role: 'system', sections: { project_context: projectContext } }]
      const result = handlers[0]?.({ messages }, {}) as { messages: typeof messages } | undefined
      return result?.messages[0]!.sections.project_context
    }
  }

  it('sends the rules as saved now, last, and drops them while the file is gone', () => {
    const rules = join(folder, 'AGENTS.md')
    writeFileSync(rules, '# Brain Agent\nOld rules')
    const send = hook()
    const started = section(GLOBAL, block(rules, '# Brain Agent\nOld rules'))
    expect(send(started)).toBeUndefined()
    writeFileSync(rules, '# Brain Agent\nNew rules')
    utimesSync(rules, new Date(), new Date(Date.now() + 5000))
    expect(send(started)).toBe(section(GLOBAL, block(rules, '# Brain Agent\nNew rules')))
    unlinkSync(rules)
    expect(send(started)).toBe(section(GLOBAL))
    writeFileSync(rules, 'Back')
    expect(send(section(GLOBAL))).toBe(section(GLOBAL, block(rules, 'Back')))
  })

  it('adds nothing when pi was started without context files', () => {
    writeFileSync(join(folder, 'AGENTS.md'), 'Rules')
    const handlers: unknown[] = []
    registerRulesReload({ on: (_e, handler) => handlers.push(handler) }, folder, [
      '--no-context-files',
    ])
    expect(handlers).toEqual([])
  })
})
