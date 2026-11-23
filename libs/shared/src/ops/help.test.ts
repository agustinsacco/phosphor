import { expect, it } from 'vitest'
import { renderHelp } from '../ops-cli'
import { OP_CATALOG } from './index'

it('builds top-level help from the supplied catalog, including unavailable domains', () => {
  const subset = OP_CATALOG.filter((s) =>
    ['help', 'lane.list', 'policy.set', 'provider.login'].includes(s.name),
  )
  expect(renderHelp(subset)).toBe(`Usage: phosphor <domain> <verb> [arguments] [options]
Options: --host H|a,b|all, --page <cursor>, --reason <text>, --json
Domains: policy, lane, provider
Commands: help
Aliases: lanes
Use phosphor help <domain> or phosphor help <domain.verb>.
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
Options: --host H|a,b|all, --page <cursor>, --reason <text>, --json`)
  expect(renderHelp(OP_CATALOG, 'lanes'))
    .toBe(`Usage: phosphor lane list [--folder <value>] [--state <value>] [options]
List a page of lanes.
Options: --host H|a,b|all, --page <cursor>, --reason <text>, --json`)
  expect(renderHelp(OP_CATALOG, 'lane.stop')).toContain('Asks the user first for another lane.')
  expect(renderHelp(OP_CATALOG, 'folder.remove', { tierNotes: false })).not.toContain('Asks')
  expect(renderHelp(OP_CATALOG, 'swarm.on')).not.toContain('--host')
  expect(renderHelp(OP_CATALOG, 'missing')).toContain('Unknown help topic')
})
