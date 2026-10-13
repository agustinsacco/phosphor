import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CustomMessage } from '@shared/rpc'
import fixture from './__fixtures__/subagent-workflow.json'
import { emptyChatSession, hydrateFromMessages, reduceChatEvent } from './reducer'
import { parseSubagentNotice } from './subagentRuns'
import { subagentHistory } from './subagentHistory'
import { SubagentNoticeItem } from './items/SubagentNotice'

vi.mock('@/components/markdown/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => createElement('p', null, text),
}))

const messages = fixture.messages as CustomMessage[]
const parse = (message: CustomMessage) =>
  parseSubagentNotice(message.customType, message.content as string, message.details)

describe('recorded pi-subagents workflow evidence', () => {
  it('retains hidden child completion in streaming, replay and active-branch history', () => {
    const live = messages.reduce(
      (state, message) => reduceChatEvent(state, { type: 'message_end', message }),
      emptyChatSession(),
    )
    const entries = messages.map((message, i) => ({
      ...message,
      type: 'custom_message',
      id: String(i),
      parentId: i ? String(i - 1) : null,
    }))
    for (const items of [
      live.items,
      hydrateFromMessages(messages).items,
      subagentHistory(entries, '1').items,
    ]) {
      expect(items).toHaveLength(2)
      expect(items[0]).toMatchObject({ customType: messages[0]!.customType, quiet: true })
    }
  })

  it('separates a completed child from its still-running workflow, without inventing acceptance', () => {
    expect(parse(messages[0]!)).toMatchObject({
      kind: 'completion',
      status: 'completed',
      headline: 'reviewer completed a workflow step',
      summary: 'Workflow was still running at this update. Execution completion is not acceptance.',
      runId: '10000001-0000-4000-8000-000000000000',
      workflowRunId: '10000000-0000-4000-8000-000000000000',
    })
  })

  it('identifies attention by workflow key and child run, keeping the original diagnostics', () => {
    expect(parse(messages[1]!)).toMatchObject({
      kind: 'attention',
      headline: 'validation · worker needs parent attention',
      runId: '10000002-0000-4000-8000-000000000000',
      childIndex: 0,
      summary: expect.stringContaining("tool 'bash' open for 240s"),
      body: messages[1]!.content,
    })
    const item = hydrateFromMessages([messages[1]!]).items[0]!
    if (item.kind !== 'custom') throw new Error('Expected notice')
    const html = renderToStaticMarkup(createElement(SubagentNoticeItem, { item }))
    expect(html).toContain('validation · worker needs parent attention')
    // Folded: the signal and the diagnostics open together.
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Elapsed time alone does not prove a stall')
    expect(html).not.toContain('command.cancel')
    expect(html).not.toContain('Waiting on you')
  })

  it('preserves unfamiliar/legacy notices and never unhides unrelated extension messages', () => {
    expect(parseSubagentNotice('subagent_control_notice', 'Legacy warning\nDetails')).toMatchObject(
      {
        headline: 'Legacy warning',
        body: 'Details',
      },
    )
    expect(parseSubagentNotice('subagent-incremental-child-notify', 'New format')).toMatchObject({
      headline: 'New format',
      runId: undefined,
    })
    expect(hydrateFromMessages([{ ...messages[0]!, customType: 'other-extension' }]).items).toEqual(
      [],
    )
  })
})
