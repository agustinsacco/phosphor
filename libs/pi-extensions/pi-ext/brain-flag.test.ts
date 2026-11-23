import { expect, it, vi } from 'vitest'
import { registerBrain } from './brain'
import type { ToolDefinition } from './pi-api'

const input = { ref: 1, problem: 'wrong', reason: 'Rina verified the billing rule changed.' }
function setup() {
  const tools = new Map<string, ToolDefinition<typeof input, unknown, unknown>>()
  const send = vi.fn<Parameters<typeof registerBrain>[1]>()
  registerBrain(
    {
      registerTool(tool) {
        tools.set(tool.name, tool as ToolDefinition<typeof input, unknown, unknown>)
      },
    },
    send,
  )
  const ctx = { sessionId: 'ignored', title: 'ignored' }
  return {
    send,
    ctx,
    flag: (params = input) =>
      tools.get('brain_flag')!.execute('flag', params, undefined, undefined, ctx),
  }
}
it.each(['filed', 'already_flagged', 'limit'] as const)(
  'forwards the displayed ref and returns the service %s without claiming a knowledge change',
  async (status) => {
    const s = setup(),
      text = 'Brain knowledge has not changed.'
    s.send.mockResolvedValue({
      v: 1,
      id: '1',
      status: 'ok',
      applies: 'now',
      text,
      data: { status },
    })
    expect(await s.flag()).toEqual({ content: [{ type: 'text', text }], details: { status } })
    expect(s.send).toHaveBeenCalledWith(
      s.ctx,
      { op: 'brain.flag', args: input },
      { signal: undefined, deadlineMs: 10_000 },
    )
  },
)
it('refuses oversize reasons and unknown fields plainly without contacting the owner', async () => {
  const s = setup()
  expect((await s.flag({ ...input, reason: 'x'.repeat(301) })).content[0]?.text).toContain(
    '1 to 300',
  )
  const extra = { ...input, memoryId: 'forged' }
  expect((await s.flag(extra)).content[0]?.text).toContain('1 to 300')
  expect(s.send).not.toHaveBeenCalled()
})
