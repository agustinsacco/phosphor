import { expect, it, vi } from 'vitest'
import type { AgentMessage } from '@phosphor/shared/rpc'
import type { BeforePromptResult } from '@phosphor/session-runtime/pi/lane-reload'
import { createRunEndings, laneReloadAction } from './lane-reload'

const onTool = [
  { role: 'assistant' },
  { role: 'toolResult', toolName: 'phosphor' },
] as unknown as AgentMessage[]
const normally = [{ role: 'assistant' }] as unknown as AgentMessage[]
const target = { laneId: 'L1', sessionId: 's2', settledSessionId: 's1' }

function harness(outcome: BeforePromptResult, admits = true) {
  const endings = createRunEndings()
  const prompt = vi.fn(async () => ({ success: true }))
  const reloadNow = vi.fn(async () => outcome)
  const action = laneReloadAction({
    reloadNow,
    endings,
    prompt,
    admitsPrompt: () => admits,
    log: () => {},
  })
  return {
    endings,
    prompt,
    reloadNow,
    run: () => action({ kind: 'reload', what: 'rules' }, target),
  }
}

it('reloads, then continues a run that ended on the tool’s terminating result', async () => {
  const h = harness('applied')
  h.endings.ended('s1', onTool)
  expect(await h.run()).toEqual({ ok: true })
  expect(h.reloadNow).toHaveBeenCalledWith('s2')
  expect(h.prompt).toHaveBeenCalledExactlyOnceWith(
    's2',
    'Phosphor reloaded this lane: rules. Continue.',
  )
})

it('still continues, saying so, when the reload did not take', async () => {
  const h = harness('failed')
  h.endings.ended('s1', onTool)
  expect(await h.run()).toEqual({ ok: false, message: 'The lane did not reload (failed).' })
  expect(h.prompt).toHaveBeenCalledWith(
    's2',
    'Phosphor could not reload this lane (failed); rules applies on its next reload. Continue.',
  )
})

it('only reloads a run that ended any other way, and continues once per ending', async () => {
  const h = harness('applied')
  h.endings.ended('s1', onTool)
  h.endings.ended('s1', normally)
  expect(await h.run()).toEqual({ ok: true })
  h.endings.ended('s1', onTool)
  await h.run()
  await h.run()
  expect(h.reloadNow).toHaveBeenCalledTimes(3)
  expect(h.prompt).toHaveBeenCalledTimes(1)
})

it('sends no continuation while a service pause refuses new turns', async () => {
  const h = harness('applied', false)
  h.endings.ended('s1', onTool)
  expect(await h.run()).toMatchObject({ ok: false })
  expect(h.prompt).not.toHaveBeenCalled()
})
