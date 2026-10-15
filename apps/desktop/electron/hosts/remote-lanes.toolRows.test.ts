import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { expect, it } from 'vitest'
import { createLaneProjection } from '@phosphor/session-runtime/lanes/projection'
import type { PiEvent } from '@shared/rpc'
import { emptyChatSession, hydrateFromMessages, reduceChatEvent } from '@/features/chat/reducer'

it('preserves fake-pi artifact and read tool rows through Host stream and snapshot projections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-tools-'))
  const child = spawn(
    process.execPath,
    [resolve('apps/host/src/__fixtures__/fake-pi.cjs'), '--mode', 'rpc'],
    {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir },
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  )
  try {
    const events = await new Promise<PiEvent[]>((done, reject) => {
      const events: PiEvent[] = []
      let buffer = ''
      const timeout = setTimeout(() => reject(new Error('fake pi timed out')), 5000)
      child.on('error', reject)
      child.stdout.on('data', (chunk) => {
        buffer += String(chunk)
        let lf: number
        while ((lf = buffer.indexOf('\n')) !== -1) {
          const event = JSON.parse(buffer.slice(0, lf))
          buffer = buffer.slice(lf + 1)
          if (event.type !== 'response') events.push(event)
          if (event.type === 'agent_settled') {
            clearTimeout(timeout)
            done(events)
          }
        }
      })
      child.stdin.write(
        JSON.stringify({ id: 'prompt', type: 'prompt', message: 'artifact links' }) + '\n',
      )
    })
    const projection = createLaneProjection({
      now: () => 0,
      overflow: () => {
        throw new Error('overflow')
      },
    })
    let live = emptyChatSession()
    for (const event of events) {
      projection.apply({ kind: 'event', event })
      live = reduceChatEvent(live, event)
    }
    const view = projection.view()
    let snapshot = hydrateFromMessages([...view.messages])
    for (const event of view.pending) snapshot = reduceChatEvent(snapshot, event)
    for (const state of [live, snapshot]) {
      const rows = state.items.flatMap((item) =>
        item.kind === 'assistant' ? item.blocks.filter((b) => b.type === 'tool') : [],
      )
      expect(rows).toHaveLength(2)
      expect(
        Object.values(state.tools)
          .map((tool) => tool.toolName)
          .sort(),
      ).toEqual(['artifact_create', 'read'])
      expect(
        Object.values(state.tools).every((tool) => tool.status === 'done' && tool.result),
      ).toBe(true)
    }
    expect(view.messages.filter((message) => message.role === 'toolResult')).toHaveLength(2)
  } finally {
    child.kill('SIGKILL')
    await new Promise<void>((done) => child.on('close', () => done()))
    rmSync(dir, { recursive: true, force: true })
  }
})
