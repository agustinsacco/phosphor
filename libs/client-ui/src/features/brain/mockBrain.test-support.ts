import { MockBrain, type MockBrainOptions } from './mockBrain'

/** Internal decisions are not IPC: the shipping mock only accepts the current channels. */
export function mockBrainHarness(
  now: () => number = () => Date.now(),
  options: MockBrainOptions = {},
) {
  const mock = new MockBrain(now, options)
  return Object.assign(
    async (channel: string, args: unknown[]) => structuredClone(mock.call(channel, args)),
    {
      decideRead: async (args: unknown[]) =>
        structuredClone(mock.decideRead(args[0] as string, args[1], args[2] as number)),
    },
  )
}
