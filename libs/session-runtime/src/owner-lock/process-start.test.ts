import { expect, it } from 'vitest'
import { parseLinuxStartTicks, readProcessStart, type ProcessStartPorts } from './process-start'

const stat = (comm: string, ticks: string) =>
  `4242 (${comm}) S 1 4242 4242 0 -1 4194560 ${'0 '.repeat(12)}${ticks} 123456 789`

it('reads field 22 of /proc/<pid>/stat after the last parenthesis of the command name', () => {
  expect(parseLinuxStartTicks(stat('node', '987654'))).toBe('987654')
  expect(parseLinuxStartTicks(stat('a) b (c', '42'))).toBe('42')
  expect(parseLinuxStartTicks('4242 node S 1')).toBeNull()
  expect(parseLinuxStartTicks(stat('node', 'x'))).toBeNull()
})

const fake = (overrides: Partial<ProcessStartPorts>): ProcessStartPorts => ({
  platform: 'linux',
  readFile: async (path) => {
    if (path === '/proc/sys/kernel/random/boot_id') return 'boot-1\n'
    if (path === '/proc/4242/stat') return stat('node', '987654')
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  },
  ps: async () => {
    throw new Error('not on linux')
  },
  ...overrides,
})

it('names the boot on Linux, so a reboot never matches an old start', async () => {
  expect(await readProcessStart(4242, fake({}))).toBe('linux:boot-1:987654')
  expect(await readProcessStart(4243, fake({}))).toBeNull()
})

it('normalizes ps lstart on macOS and reads nothing for a gone process', async () => {
  const calls: number[] = []
  const ports = fake({
    platform: 'darwin',
    ps: async (pid) => {
      calls.push(pid)
      if (pid !== 4242) throw new Error('exit 1')
      return 'Sun Nov 22  22:00:00 2026\n'
    },
  })
  expect(await readProcessStart(4242, ports)).toBe('darwin:Sun Nov 22 22:00:00 2026')
  expect(await readProcessStart(4243, ports)).toBeNull()
  expect(
    await readProcessStart(4242, fake({ platform: 'darwin', ps: async () => '\n' })),
  ).toBeNull()
  expect(calls).toEqual([4242, 4243])
})

it('reads nothing on other platforms or for an invalid pid', async () => {
  expect(await readProcessStart(4242, fake({ platform: 'win32' }))).toBeNull()
  for (const pid of [0, -1, 1.5, 2147483648])
    expect(await readProcessStart(pid, fake({}))).toBeNull()
})
