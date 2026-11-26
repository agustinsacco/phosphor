import { Type } from 'typebox'
import type { OpArgs } from '../types'
import { MCP_EXPOSURES } from '../../mcp'
import { validMcpConfig } from '../../machine-settings-mcp'
import {
  caps,
  choice,
  configure,
  content,
  count,
  domain,
  id,
  object,
  on,
  optional,
  path,
  previous,
  reverse,
  text,
  untrusted,
} from './spec'

const scope = choice('global', 'project')
const read = domain('machine', configure, untrusted)
const change = domain('machine', configure, { applies: 'reload' })
const byName = { positional: ['name'] } as const
const packageDeadline = { deadlineMs: 600_000 }
const skill = { scope: choice('user', 'project'), name: id, project: optional(path) }
const skillFlag = { flag: 'configFiles' } as const
const connector = { name: id, scope, project: optional(path) }
// No auth material or owner approval flag is accepted from an agent.
const config = Type.Refine(
  object({
    type: optional(choice('http', 'streamable-http', 'stdio')),
    command: optional(path),
    args: optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64 })),
    url: optional(text(8192)),
    cwd: optional(path),
    enabled: optional(on),
    description: optional(text(2000)),
    exposure: optional(choice(...MCP_EXPOSURES)),
    timeout: optional(count(300)),
  }),
  validMcpConfig,
)
const connectorTier = ({ config }: OpArgs) =>
  validMcpConfig(config) && typeof config.command === 'string' ? 'destructive' : 'persistence'

export const resources = [
  read('skill.list', 'List available skills.', 'read', object({ project: optional(path) }), {
    requires: caps('skills.read'),
  }),
  read(
    'skill.read',
    'Read a file from a skill.',
    'read',
    object({ name: id, file: optional(path) }),
    { ...byName, requires: caps('skills.read') },
  ),
  change(
    'skill.create',
    'Create a skill.',
    'persistence',
    object({ ...skill, description: text(2000), content, draft: optional(on) }),
    { ...byName, ...skillFlag, sensitive: ['content'] },
  ),
  change(
    'skill.edit',
    'Edit a skill file.',
    'persistence',
    object({ ...skill, file: optional(path), content }),
    { ...byName, ...skillFlag, sensitive: ['content'], inverse: previous('skill.edit') },
  ),
  change(
    'skill.install',
    'Install a catalog skill.',
    'persistence',
    object({ ...skill, libraryId: id, overwrite: optional(on) }),
    byName,
  ),
  change(
    'skill.share',
    'Share a skill with another machine.',
    'persistence',
    object({ ...skill, to: id }),
    byName,
  ),
  change('skill.delete', 'Delete a skill.', 'destructive', object(skill), {
    ...byName,
    ...skillFlag,
    applies: 'now',
  }),
  read(
    'mcp.list',
    'List configured MCP servers without credentials.',
    'read',
    object({ project: optional(path) }),
  ),
  read(
    'mcp.check',
    'Check an MCP server.',
    'read',
    object({ name: id, project: optional(path) }),
    byName,
  ),
  change('mcp.add', 'Add an MCP server.', connectorTier, object({ ...connector, config }), {
    ...byName,
    sensitive: ['config'],
    inverse: ({ name, scope, project }) => ({
      op: 'mcp.remove',
      args: { name, scope, ...(project ? { project } : {}) },
    }),
  }),
  change('mcp.update', 'Update an MCP server.', connectorTier, object({ ...connector, config }), {
    ...byName,
    sensitive: ['config'],
    inverse: previous('mcp.update'),
  }),
  change('mcp.enable', 'Enable an MCP server.', 'persistence', object(connector), {
    ...byName,
    inverse: reverse('mcp.disable'),
  }),
  change('mcp.disable', 'Disable an MCP server.', 'persistence', object(connector), {
    ...byName,
    inverse: reverse('mcp.enable'),
  }),
  change(
    'mcp.expose',
    'Change how server tools are exposed.',
    'persistence',
    object({ ...connector, exposure: choice(...MCP_EXPOSURES) }),
    { ...byName, inverse: previous('mcp.expose') },
  ),
  change('mcp.remove', 'Delete an MCP server configuration.', 'destructive', object(connector), {
    ...byName,
    applies: 'now',
  }),
  read(
    'package.list',
    'List installed packages.',
    'read',
    object({ project: optional(path) }),
    packageDeadline,
  ),
  read(
    'package.checkUpdates',
    'Check for package updates.',
    'read',
    object({ project: optional(path) }),
    packageDeadline,
  ),
  ...(['install', 'update', 'remove'] as const).map((action) =>
    change(
      `package.${action}`,
      {
        install: 'Install a package.',
        update: 'Update installed packages.',
        remove: 'Remove a package.',
      }[action],
      'persistence',
      object({ spec: action === 'update' ? optional(id) : id, scope, project: optional(path) }),
      {
        ...packageDeadline,
        job: true,
        positional: ['spec'],
        ...(action === 'update'
          ? {}
          : { inverse: reverse(action === 'install' ? 'package.remove' : 'package.install') }),
      },
    ),
  ),
  change('claude.installProvider', 'Install the Claude provider.', 'persistence', undefined, {
    job: true,
  }),
  change('claude.installCli', 'Install the Claude CLI.', 'persistence', undefined, { job: true }),
]
