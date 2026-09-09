import { describe, expect, it } from 'vitest'
import {
  buildTranscriptRows,
  externalToolInfo,
  isActivityLive,
  isResultMarker,
  parseExternalToolMarker,
  parseResultPayload,
  summarizeActivity,
  type ExternalToolBlock,
} from './transcriptRows'
import { settledVerb, summarizeExternalTool } from '../tools/toolSummaries'
import type { AssistantBlock, AssistantItem, ChatItem } from '../reducer'

/**
 * CLI-side tool RESULTS (`pi-claude-cli` >= 0.6.0, payload metrics >= 0.8.0).
 *
 * With `PI_CLAUDE_CLI_TOOL_RESULTS=1` the provider tags each call marker with
 * its `tool_use_id` and follows it with a `result` marker. Two rules matter
 * more than any of the parsing:
 *
 * 1. A result is **not a row**. It is the second half of the row its call
 *    already produced — rendered as its own row it reads as a tool named
 *    "result", which is the raw-JSON-in-the-transcript problem the marker
 *    exists to avoid.
 * 2. The pairing has to **outlive a message**. The CLI reports a tool's
 *    result in whatever episode it finishes in, which is routinely a later
 *    assistant message than the one that announced the call.
 */

let seq = 0
const nextId = (): string => `i${++seq}`

const marker = (index: number, text: string): AssistantBlock => ({
  type: 'text',
  index,
  text,
  closed: true,
})

const assistant = (
  blocks: AssistantBlock[],
  extra: Partial<AssistantItem> = {},
): AssistantItem => ({
  id: nextId(),
  kind: 'assistant',
  blocks,
  streaming: false,
  ...extra,
})

/** Every `externalTool` block in the built rows, in order. */
function externalBlocks(items: ChatItem[]): ExternalToolBlock[] {
  return buildTranscriptRows(items)
    .flatMap((row) => (row.kind === 'activity' ? row.steps : []))
    .map((step) => step.block)
    .filter((block): block is ExternalToolBlock => block.type === 'externalTool')
}

describe('parseExternalToolMarker with an id tag', () => {
  it('separates the id from the arguments', () => {
    expect(
      parseExternalToolMarker('[Claude Code · Read #toolu_01A {"file_path":"/a.ts"}]'),
    ).toEqual({
      name: 'Read',
      toolUseId: 'toolu_01A',
      args: '{"file_path":"/a.ts"}',
    })
  })

  it('reads an id-only marker (a call with no arguments)', () => {
    expect(parseExternalToolMarker('[Claude Code · Bash #t9]')).toEqual({
      name: 'Bash',
      toolUseId: 't9',
      args: undefined,
    })
  })

  it('leaves an untagged marker exactly as before', () => {
    expect(parseExternalToolMarker('[Claude Code · WebSearch {"query":"pi"}]')).toEqual({
      name: 'WebSearch',
      toolUseId: undefined,
      args: '{"query":"pi"}',
    })
  })

  it('recognises the result marker by name', () => {
    const parsed = parseExternalToolMarker('[Claude Code · result #t1 {"status":"ok"}]')!
    expect(isResultMarker(parsed.name)).toBe(true)
    expect(isResultMarker('Read')).toBe(false)
  })
})

describe('parseResultPayload', () => {
  it('reads status, summary and preview', () => {
    expect(
      parseResultPayload(
        '{"status":"ok","tool":"Read","summary":"419 lines","preview":"1\\talpha","length":8}',
      ),
    ).toEqual({
      status: 'ok',
      summary: '419 lines',
      error: undefined,
      preview: '1\talpha',
      length: 8,
      truncated: false,
    })
  })

  it('reads a failure and its message', () => {
    const result = parseResultPayload(
      '{"status":"error","summary":"exit 1 · no such file","error":"no such file","preview":"Exit code 1"}',
    )!
    expect(result.status).toBe('error')
    expect(result.error).toBe('no such file')
  })

  it('flags a truncated preview', () => {
    expect(
      parseResultPayload('{"status":"ok","preview":"x","length":5000,"truncated":true}'),
    ).toMatchObject({ truncated: true, length: 5000 })
  })

  /**
   * A provider between 0.6.0 and 0.7.1 sends `{status, preview, length}` and
   * no metrics. It must still pair and still expand — the row just has no
   * outcome line to show.
   */
  it('accepts the leaner pre-0.8.0 payload', () => {
    expect(parseResultPayload('{"status":"ok","preview":"hi","length":2}')).toMatchObject({
      status: 'ok',
      summary: undefined,
      preview: 'hi',
    })
  })

  it('refuses anything that is not a JSON object, rather than guessing', () => {
    for (const args of [undefined, '', 'not json', '[1,2]', '"ok"', '{"status":"ok"']) {
      expect(parseResultPayload(args)).toBeNull()
    }
  })

  it('treats an unknown status as ok, never as a silent failure', () => {
    expect(parseResultPayload('{"status":"weird"}')!.status).toBe('ok')
  })
})

describe('buildTranscriptRows folds results into their calls', () => {
  it('attaches the result to the call and adds no row of its own', () => {
    const blocks = externalBlocks([
      assistant([
        marker(0, '[Claude Code · Read #t1 {"file_path":"/repo/a.ts"}]'),
        marker(1, '[Claude Code · result #t1 {"status":"ok","summary":"419 lines"}]'),
      ]),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.name).toBe('Read')
    expect(blocks[0]!.result).toMatchObject({ status: 'ok', summary: '419 lines' })
  })

  it('pairs across assistant messages', () => {
    const blocks = externalBlocks([
      assistant([marker(0, '[Claude Code · Bash #t1 {"command":"npm test"}]')]),
      assistant([marker(0, '[Claude Code · result #t1 {"status":"error","summary":"exit 1"}]')]),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.result?.status).toBe('error')
  })

  it('pairs by id, not by order', () => {
    const blocks = externalBlocks([
      assistant([
        marker(0, '[Claude Code · Read #t1 {"file_path":"/a.ts"}]'),
        marker(1, '[Claude Code · Bash #t2 {"command":"ls"}]'),
        marker(2, '[Claude Code · result #t2 {"status":"ok","summary":"4 lines out"}]'),
        marker(3, '[Claude Code · result #t1 {"status":"ok","summary":"12 lines"}]'),
      ]),
    ])
    expect(blocks.map((b) => [b.name, b.result?.summary])).toEqual([
      ['Read', '12 lines'],
      ['Bash', '4 lines out'],
    ])
  })

  it('drops a result whose call it never saw, instead of rendering it', () => {
    const blocks = externalBlocks([
      assistant([marker(0, '[Claude Code · result #ghost {"status":"ok"}]')]),
    ])
    expect(blocks).toEqual([])
  })

  it('leaves a call with no result unsettled rather than inventing one', () => {
    const blocks = externalBlocks([
      assistant([marker(0, '[Claude Code · WebSearch #t1 {"query":"pi"}]')]),
    ])
    expect(blocks[0]!.toolUseId).toBe('t1')
    expect(blocks[0]!.result).toBeUndefined()
  })

  it('keeps an unparseable payload off the row', () => {
    const blocks = externalBlocks([
      assistant([
        marker(0, '[Claude Code · Read #t1 {"file_path":"/a.ts"}]'),
        marker(1, '[Claude Code · result #t1 not-json]'),
      ]),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.result).toBeUndefined()
  })
})

/**
 * The 0.8.0 call payload, read by the label path.
 *
 * It is complete JSON now, and it keeps its newlines — both on purpose, and
 * both load-bearing for the row: `commandHeadline` picks the operative line
 * out of a multi-line command and counts the rest, which a flattened command
 * would defeat. This is the cross-repo assumption, so it is pinned here
 * rather than left to the provider's own tests.
 */
describe('the complete-JSON call payload', () => {
  it('reads a path clipped from the front and still names the file', () => {
    const parsed = parseExternalToolMarker(
      '[Claude Code · Read #t1 {"file_path":"…/features/chat/items/transcriptRows.ts"}]',
    )!
    const summary = summarizeExternalTool('Read', externalToolInfo('Read', parsed.args).fields)
    expect(summary.label).toBe('Read')
    expect(summary.object).toBe('transcriptRows.ts')
  })

  it('puts the operative line of a multi-line command on the row', () => {
    const parsed = parseExternalToolMarker(
      '[Claude Code · Bash #t1 {"command":"set -e\\ncd /tmp\\nnpm run lint\\n","description":"Lint"}]',
    )!
    const summary = summarizeExternalTool('Bash', externalToolInfo('Bash', parsed.args).fields)
    expect(summary.label).toBe('Ran')
    // The work, not the `set -e`/`cd` preamble — which is only separable
    // because the payload kept the line breaks.
    expect(summary.object).toBe('npm run lint')
  })

  it('counts the commands the row could not show', () => {
    const parsed = parseExternalToolMarker(
      '[Claude Code · Bash #t1 {"command":"npm run lint\\nnpm test\\nnpm run build"}]',
    )!
    const summary = summarizeExternalTool('Bash', externalToolInfo('Bash', parsed.args).fields)
    expect(summary.object).toBe('npm run lint')
    expect(summary.hint).toBe('+2 more')
  })

  it('reads the measurements that replaced a bulk argument', () => {
    const parsed = parseExternalToolMarker(
      '[Claude Code · Write #t1 {"file_path":"/repo/poem.txt","lines":3,"bytes":70}]',
    )!
    // Numbers are not row labels, but they must not break the label either:
    // the file is what a Write row says.
    const summary = summarizeExternalTool('Write', externalToolInfo('Write', parsed.args).fields)
    expect(summary.label).toBe('Created')
    expect(summary.object).toBe('poem.txt')
  })
})

describe('a tagged call is live work until its result lands', () => {
  const step = (block: ExternalToolBlock, streaming: boolean) => ({
    itemId: 'a1',
    block,
    streaming,
    isLastInItem: true,
  })
  const call = (over: Partial<ExternalToolBlock> = {}): ExternalToolBlock => ({
    type: 'externalTool',
    index: 0,
    name: 'WebSearch',
    toolUseId: 't1',
    ...over,
  })

  it('is live while the message streams and no result has arrived', () => {
    expect(isActivityLive([step(call(), true)], {})).toBe(true)
  })

  it('settles once the result arrives', () => {
    expect(isActivityLive([step(call({ result: { status: 'ok' } }), true)], {})).toBe(false)
  })

  /**
   * An unanswered call on a settled turn means the CLI never reported — it
   * died, or the host has forwarding off. A group open forever is worse than
   * a row that stops spinning.
   */
  it('settles when the turn is over, answered or not', () => {
    expect(isActivityLive([step(call(), false)], {})).toBe(false)
  })

  it('never claims an untagged call is running', () => {
    expect(isActivityLive([step(call({ toolUseId: undefined }), true)], {})).toBe(false)
  })
})

describe('the collapsed head counts CLI-side failures', () => {
  it('reports a failed CLI-side tool like a failed pi tool', () => {
    const rows = buildTranscriptRows([
      assistant([
        marker(0, '[Claude Code · Bash #t1 {"command":"ls /nope"}]'),
        marker(1, '[Claude Code · result #t1 {"status":"error","summary":"exit 1"}]'),
        marker(2, '[Claude Code · Bash #t2 {"command":"ls"}]'),
        marker(3, '[Claude Code · result #t2 {"status":"ok","summary":"4 lines out"}]'),
      ]),
    ])
    const activity = rows.find((row) => row.kind === 'activity')!
    if (activity.kind !== 'activity') throw new Error('expected an activity row')
    const summary = summarizeActivity(activity.steps, {}, (tool) => settledVerb(tool.toolName))
    expect(summary.failedCount).toBe(1)
    expect(summary.stepLabel).toBe('2 steps')
  })
})
