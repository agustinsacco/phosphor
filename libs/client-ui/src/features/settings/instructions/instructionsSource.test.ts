import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostInstructions, localInstructions, sizeLabel } from './instructionsSource'

const file = { path: '/home/bee/.pi/agent/AGENTS.md', content: 'x', revision: 'r', exists: true }

afterEach(() => vi.unstubAllGlobals())

describe('instructions sources', () => {
  it('reads and saves This computer through its own channels', async () => {
    const invoke = vi.fn(async () => file)
    vi.stubGlobal('window', { phosphor: { invoke } })
    const source = localInstructions('This Mac')
    await source.read()
    await source.save('new', 'r')
    expect(invoke.mock.calls).toEqual([
      ['pi:readInstructions'],
      ['pi:writeInstructions', 'new', 'r'],
    ])
  })

  it("saves a Host's file as an instructions change at the revision it read", async () => {
    const invoke = vi.fn(async () => ({
      section: 'instructions',
      revision: 'r',
      instructions: file,
    }))
    vi.stubGlobal('window', { phosphor: { invoke } })
    const source = hostInstructions('host-1', 'bee1')
    expect(source.key).not.toBe(hostInstructions('host-2', 'bee2').key)
    await expect(source.read()).resolves.toEqual(file)
    await source.save('new', 'r')
    expect(invoke.mock.calls).toEqual([
      ['hosts:settingsRead', 'host-1', 'instructions'],
      [
        'hosts:settingsPatch',
        'host-1',
        {
          section: 'instructions',
          revision: 'r',
          change: { type: 'instructions.write', content: 'new' },
        },
      ],
    ])
  })

  it('asks for a Host update when the Host has no instructions section', async () => {
    vi.stubGlobal('window', {
      phosphor: { invoke: vi.fn(async () => ({ section: 'instructions', revision: 'r' })) },
    })
    await expect(hostInstructions('h', 'old').read()).rejects.toThrow('Update this Host')
  })

  it('counts the bytes every request carries', () => {
    expect(sizeLabel('abc')).toBe('3 B')
    expect(sizeLabel('é'.repeat(1024))).toBe('2.0 KB')
  })
})
