import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateCommandCaches,
  probeCommandsCached,
  requireCommands,
  type CommandProbeOptions,
} from './commands'
import type { RpcSlashCommand } from '@shared/rpc'

const rpc = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('./desktop-rpc-client', () => ({
  PiRpcClient: class {
    spawn() {}
    request = rpc.request
    async dispose() {}
  },
}))

const ANSWER: RpcSlashCommand[] = [{ name: 'one', source: 'extension' }]

const options = (workspacePath?: string): CommandProbeOptions => ({
  ...(workspacePath ? { workspacePath } : {}),
  binaryPath: '/bin/pi',
})

describe('probeCommandsCached', () => {
  beforeEach(() => {
    invalidateCommandCaches()
    vi.useRealTimers()
  })

  it('asks pi once per folder and answers from memory after that', async () => {
    const probe = vi.fn(async () => ANSWER)
    expect(await probeCommandsCached(options('/a'), { probe })).toBe(ANSWER)
    expect(await probeCommandsCached(options('/a'), { probe })).toBe(ANSWER)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('keeps one answer per folder — project prompts differ by workspace', async () => {
    const probe = vi.fn(async (o: CommandProbeOptions) => [
      { name: o.workspacePath ?? 'none', source: 'prompt' as const },
    ])
    expect((await probeCommandsCached(options('/a'), { probe }))[0]!.name).toBe('/a')
    expect((await probeCommandsCached(options('/b'), { probe }))[0]!.name).toBe('/b')
    expect((await probeCommandsCached(options(), { probe }))[0]!.name).toBe('none')
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('re-asks when told to be fresh, and stores that answer', async () => {
    const probe = vi.fn(async () => ANSWER)
    await probeCommandsCached(options('/a'), { probe })
    await probeCommandsCached(options('/a'), { probe, fresh: true })
    await probeCommandsCached(options('/a'), { probe })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('re-asks after the caches are invalidated', async () => {
    const probe = vi.fn(async () => ANSWER)
    await probeCommandsCached(options('/a'), { probe })
    invalidateCommandCaches()
    await probeCommandsCached(options('/a'), { probe })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('uses the options of the latest call when it does re-ask', async () => {
    // pi installed between two calls: the first miss remembered a loader; the
    // next load must not spawn with the old binary.
    const probe = vi.fn(async (o: CommandProbeOptions) => [
      { name: o.binaryPath ?? '', source: 'extension' as const },
    ])
    await probeCommandsCached({ workspacePath: '/a', binaryPath: '/old/pi' }, { probe })
    const fresh = await probeCommandsCached(
      { workspacePath: '/a', binaryPath: '/new/pi' },
      { probe, fresh: true },
    )
    expect(fresh[0]!.name).toBe('/new/pi')
  })

  it('does not remember a failure', async () => {
    const probe = vi
      .fn<(o: CommandProbeOptions) => Promise<RpcSlashCommand[]>>()
      .mockRejectedValueOnce(new Error('commands probe timed out'))
      .mockResolvedValueOnce(ANSWER)
    await expect(probeCommandsCached(options('/a'), { probe })).rejects.toThrow('timed out')
    expect(await probeCommandsCached(options('/a'), { probe })).toBe(ANSWER)
  })

  it('dedupes concurrent callers into one spawn', async () => {
    let resolve!: (value: RpcSlashCommand[]) => void
    const probe = vi.fn(() => new Promise<RpcSlashCommand[]>((r) => (resolve = r)))
    const a = probeCommandsCached(options('/a'), { probe })
    const b = probeCommandsCached(options('/a'), { probe })
    resolve(ANSWER)
    expect(await a).toBe(ANSWER)
    expect(await b).toBe(ANSWER)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

// Skill sharing decides whether a copy would be shadowed from this answer; an empty list
// because pi could not answer must not read as "no skills".
describe('requireCommands', () => {
  it('fails when pi is missing or does not answer, and returns a real answer', async () => {
    await expect(requireCommands({})).rejects.toThrow()
    rpc.request.mockResolvedValueOnce({ success: false, error: 'boom' })
    await expect(requireCommands(options())).rejects.toThrow()
    rpc.request.mockResolvedValueOnce({ success: true, data: { commands: ANSWER } })
    expect(await requireCommands(options())).toBe(ANSWER)
  })
})
