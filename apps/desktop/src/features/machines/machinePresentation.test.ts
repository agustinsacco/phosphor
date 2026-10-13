import { expect, it } from 'vitest'
import {
  formatCode,
  HOST_INSTALL,
  localMachineLabel,
  machineSubtitle,
  platformName,
  readinessFreshness,
  readinessChecks,
  relativeTime,
  sortMachines,
  statusText,
} from './machinePresentation'
import { MACHINE } from './__fixtures__/control'
const now = Date.parse('2026-01-01T03:00:00.000Z')
it('uses shared clock correction and labels every state', () => {
  expect(statusText(MACHINE, now)).toBe('Waiting for first connection')
  const online = { ...MACHINE, lastSeenAt: new Date(now).toISOString(), state: 'running' as const }
  expect(statusText(online, now)).toBe('Online')
  expect(statusText({ ...online, lastSeenAt: '2026-01-01T00:00:00.000Z' }, now)).toBe(
    'Offline · last seen 3 h ago',
  )
  expect(statusText({ ...online, state: 'stopping' }, now)).toBe('Stopping')
  expect(
    statusText(
      { ...online, state: 'stopping', lastSeenAt: new Date(now - 91_000).toISOString() },
      now,
    ),
  ).toBe('Offline · last seen 1 min ago')
  expect(statusText(online, now + 600000, -600000)).toBe('Online')
  expect(relativeTime(online.lastSeenAt, now - 10000)).toBe('just now')
  expect(platformName('darwin')).toBe('macOS')
  expect(platformName('win32')).toBe('Windows')
  expect(platformName('linux')).toBe('Linux')
})
it('sorts online first then label without mutating input', () => {
  const entries = [
    { ...MACHINE, label: 'Z', id: 'z' },
    {
      ...MACHINE,
      label: 'B',
      id: 'b',
      lastSeenAt: new Date(now).toISOString(),
      state: 'running' as const,
    },
    { ...MACHINE, label: 'A', id: 'a' },
  ]
  expect(sortMachines(entries, now).map((m) => m.label)).toEqual(['B', 'A', 'Z'])
  expect(entries.map((m) => m.label)).toEqual(['Z', 'B', 'A'])
})
it('gives problem-only readiness and actionable fixes, including unknown reports', () => {
  expect(
    readinessChecks({ pi: 'ok', claude: 'ok', tailscale: 'ok' }).every(
      (check) => check.ok && !check.command,
    ),
  ).toBe(true)
  expect(readinessChecks(MACHINE.readiness).find((check) => check.name === 'Claude')?.command).toBe(
    'phosphor providers login claude',
  )
  expect(
    readinessChecks({ pi: 'missing', claude: 'missing', tailscale: 'stopped' }).map(
      (check) => check.command,
    ),
  ).toEqual([
    'npm install -g @earendil-works/pi-coding-agent',
    'npm install -g @anthropic-ai/claude-code',
    'sudo tailscale up',
  ])
  expect(
    readinessChecks(null).every((check) => !check.ok && check.command === 'phosphor doctor'),
  ).toBe(true)
  expect(
    readinessChecks({ pi: 'outdated', claude: 'unknown', tailscale: 'no-https' })[2]?.detail,
  ).toContain('admin console')
})
it.each(['bcdfghjk', 'BCDF-GHJK', ' bcdf-ghjk '])('normalises and formats %s', (code) =>
  expect(formatCode(code)).toBe('BCDF-GHJK'),
)
it('pins the verified source installation, not a fictional package', () => {
  expect(HOST_INSTALL)
    .toBe(`git clone --depth 1 https://github.com/agustinsacco/phosphor.git ~/src/phosphor
cd ~/src/phosphor && npm ci --ignore-scripts
npm run build:host -- --out ~/.local/share/phosphor-host
mkdir -p ~/.local/bin
printf '#!/bin/sh\\nexec %s %s "$@"\\n' "$(readlink -f "$(command -v node)")" ~/.local/share/phosphor-host/phosphor.mjs > ~/.local/bin/phosphor && chmod 755 ~/.local/bin/phosphor`)
})
it('trusts readiness only while a machine is online, and names problems in a few words', () => {
  const online = { ...MACHINE, lastSeenAt: new Date(now).toISOString(), state: 'running' as const }
  expect(readinessFreshness(MACHINE, now)).toBe('none')
  expect(readinessFreshness({ ...online, readiness: null }, now)).toBe('none')
  expect(readinessFreshness(online, now)).toBe('live')
  expect(readinessFreshness({ ...online, lastSeenAt: '2026-01-01T00:00:00.000Z' }, now)).toBe(
    'stale',
  )
  expect(
    readinessChecks({ pi: 'outdated', claude: 'signed-out', tailscale: 'no-https' }).map(
      (check) => check.short,
    ),
  ).toEqual(['pi outdated', 'Claude signed out', 'No Tailscale HTTPS'])
  expect(readinessChecks(null).map((check) => check.short)).toEqual([
    'pi not reported',
    'Claude not reported',
    'Tailscale not reported',
  ])
  expect(machineSubtitle(online, now)).toBe('bee1 · Linux x64 · Online')
  expect(localMachineLabel('darwin')).toBe('This Mac')
  expect(localMachineLabel('win32')).toBe('This PC')
  expect(localMachineLabel('linux')).toBe('This computer')
})
it('never suggests piping a download into a shell', () => {
  const missing = readinessChecks({ pi: 'ok', claude: 'ok', tailscale: 'missing' })[2]
  expect(missing?.command).toBeUndefined()
  expect(missing?.detail).toContain('tailscale.com/download')
})
