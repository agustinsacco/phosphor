import { expect, it } from 'vitest'
import { renderHelp } from '../ops-cli'
import { OP_CATALOG } from './index'

it('builds top-level help from the supplied catalog, including unavailable domains', () => {
  const subset = OP_CATALOG.filter((s) =>
    ['help', 'lane.list', 'policy.set', 'provider.login'].includes(s.name),
  )
  expect(renderHelp(subset)).toBe(`Usage: phosphor <domain> <verb> [arguments] [options]
Domains: policy, lane, provider
Commands: help
Aliases: lanes
Use phosphor help <domain> or phosphor help <domain.verb> for arguments and options.
--host takes a machine name, an ID prefix of 8 or more hex characters, a,b, or all: every other machine, never this one.
Not available to agents: policy.set, provider.login`)
})

it('keeps surface and never operations in one section rather than advertising them as agent commands', () => {
  expect(renderHelp(OP_CATALOG, 'audit')).toBe(`audit:
  audit.list: List audited agent operations.
Not available to agents: audit.undo`)
  expect(renderHelp(OP_CATALOG, 'confirm.approve')).toBe('Not available to agents: confirm.approve')
})

it('generates usage, confirmation notes, aliases and supported global options', () => {
  expect(renderHelp(OP_CATALOG, 'folder.remove')).toBe(`Usage: phosphor folder remove <id> [options]
Remove a folder from the machine’s list. Asks the user first.
Options: --host H|a,b|all, --reason <text>, --json, --help`)
  expect(renderHelp(OP_CATALOG, 'lanes')).toContain(
    'Usage: phosphor lane list [--folder <folder>] [--state <state>]',
  )
  expect(renderHelp(OP_CATALOG, 'lane.stop')).toContain('Asks the user first for another lane.')
  expect(renderHelp(OP_CATALOG, 'folder.remove', { tierNotes: false })).not.toContain('Asks')
  expect(renderHelp(OP_CATALOG, 'swarm.on')).not.toContain('--host')
  expect(renderHelp(OP_CATALOG, 'missing')).toContain('Unknown help topic')
})

it('shows semantic labels, schema choices and only the options an op accepts', () => {
  const catalog = OP_CATALOG.map((s) =>
    s.name === 'lane.list' ? { ...s, paged: true as const } : { ...s, paged: undefined },
  )
  const read = renderHelp(catalog, 'lane read')
  expect(read).toContain('<lane-ref>')
  expect(read).toContain('--part summary|messages|artifacts|prs|debug')
  expect(read).toContain('--messages <1–50>')
  expect(read).not.toContain('--page')
  expect(read).not.toContain('--limit')
  expect(renderHelp(catalog, 'lanes')).toContain('--limit <1–100> (default 20)')
  expect(renderHelp(catalog, 'files.read')).toContain('--target <lane-ref>')
})

it('labels a non-paged limit as a catalog argument, not a paging option', () => {
  const [usage, , options] = renderHelp(OP_CATALOG, 'brain.search').split('\n')
  expect(usage).toContain('[--limit <1–20>]')
  expect(options).not.toMatch(/--limit|--page/)
})
