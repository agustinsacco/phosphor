import { beforeEach, describe, expect, it } from 'vitest'
import { presentText, promptText, usePromptStore, type PromptRequest } from './prompt'

function head(): PromptRequest {
  const request = usePromptStore.getState().requests[0]
  if (!request) throw new Error('expected a queued prompt')
  return request
}

describe('prompt store', () => {
  beforeEach(() => {
    usePromptStore.setState({ requests: [] })
  })

  it('resolves with the submitted value', async () => {
    const pending = promptText({ title: 'Rename session' })
    usePromptStore.getState().dismiss(head(), 'new name')
    await expect(pending).resolves.toBe('new name')
    expect(usePromptStore.getState().requests).toHaveLength(0)
  })

  it('resolves undefined on cancel', async () => {
    const pending = promptText({ title: 'Rename session' })
    usePromptStore.getState().dismiss(head(), undefined)
    await expect(pending).resolves.toBeUndefined()
  })

  it('queues requests FIFO so only the head renders', async () => {
    const first = promptText({ title: 'One' })
    const second = promptText({ title: 'Two' })
    expect(usePromptStore.getState().requests.map((r) => r.title)).toEqual(['One', 'Two'])
    usePromptStore.getState().dismiss(head(), 'a')
    await expect(first).resolves.toBe('a')
    expect(head().title).toBe('Two')
    usePromptStore.getState().dismiss(head(), undefined)
    await expect(second).resolves.toBeUndefined()
  })

  it('presentText resolves when the display dialog is closed', async () => {
    const pending = presentText({ title: 'Copy', text: 'debug info' })
    expect(head().kind).toBe('display')
    expect(head().text).toBe('debug info')
    usePromptStore.getState().dismiss(head(), undefined)
    await expect(pending).resolves.toBeUndefined()
  })
})
