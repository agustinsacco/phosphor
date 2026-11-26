import { Type } from 'typebox'
import { AGENT_FIELDS } from '../../machine-agent-behavior'
import { MACHINE_SETTINGS_SECTIONS } from '../../machine-settings'
import { AGENT_DIRECTIVE_KEYS } from '../../models/directives'
import {
  choice,
  configure,
  content,
  domain,
  id,
  object,
  on,
  optional,
  paged,
  previous,
  untrusted,
} from './spec'

const settings = domain('machine', configure)
const project = optional(on)
const file = choice('settings', 'models', 'web-search')
// The binding reads/sets Headroom through the owner methods headroom.status and headroom.set.
const key = choice(
  ...Object.keys(AGENT_FIELDS),
  'defaultProvider',
  'defaultModel',
  'contextBudget',
  'autoNameLanes',
  'headroom',
)
export const settingsOps = [
  settings(
    'settings.read',
    'Read machine settings, omitting credentials.',
    'read',
    object({ section: optional(choice(...MACHINE_SETTINGS_SECTIONS, 'headroom')), project }),
    { positional: ['section'], ...untrusted },
  ),
  settings(
    'settings.set',
    'Set an agent default, context budget or Headroom preference.',
    'configure',
    object({
      key,
      value: Type.Union([Type.String({ maxLength: 4096 }), Type.Number(), on, Type.Null()]),
      project,
    }),
    { applies: 'new-lanes', positional: ['key', 'value'], inverse: previous('settings.set') },
  ),
  settings(
    'directives.read',
    'Read directive overrides and effective values.',
    'read',
    object({ project: optional(Type.Union([on, Type.String({ pattern: '^[0-9a-f]{16}$' })])) }),
    untrusted,
  ),
  settings(
    'directives.set',
    'Enable or disable a prompt directive.',
    'configure',
    object({
      key: choice(...AGENT_DIRECTIVE_KEYS),
      on,
      project: optional(Type.Union([on, Type.String({ pattern: '^[0-9a-f]{16}$' })])),
    }),
    {
      applies: 'next-request',
      flag: 'folderDirectives',
      positional: ['key', 'on'],
      inverse: previous('directives.set'),
    },
  ),
  settings('instructions.read', 'Read instructions.', 'read', object({ project }), untrusted),
  settings(
    'instructions.edit',
    'Replace instructions at the expected revision.',
    'persistence',
    object({ content, revision: Type.Union([id, Type.Null()]), project }),
    { applies: 'next-request', sensitive: ['content'], inverse: previous('instructions.edit') },
  ),
  settings(
    'config.read',
    'Read the settings file, never a credential file.',
    (a) => (a.file === 'settings' ? 'read' : 'never'),
    object({ file, project }),
    { flag: 'configFiles', positional: ['file'], ...untrusted },
  ),
  settings(
    'config.write',
    'Write the settings file, never a credential file.',
    (a) => (a.file === 'settings' ? 'persistence' : 'never'),
    object({ file, project, content }),
    {
      flag: 'configFiles',
      applies: 'reload',
      positional: ['file'],
      sensitive: ['content'],
      inverse: previous('config.write'),
    },
  ),
  settings(
    'claude.accounts',
    'List Claude account metadata without credentials.',
    'read',
    undefined,
    { ...untrusted, ...paged },
  ),
  settings(
    'claude.routing',
    'Set how new lanes choose a Claude account.',
    'configure',
    object({ mode: choice('specific', 'ordered', 'round-robin'), pinnedId: optional(id) }),
    { applies: 'new-lanes', positional: ['mode'], inverse: previous('claude.routing') },
  ),
  settings(
    'claude.reorder',
    'Set the Claude account order.',
    'configure',
    object({ ids: Type.Array(id, { minItems: 1, maxItems: 16, uniqueItems: true }) }),
    { applies: 'new-lanes', inverse: previous('claude.reorder') },
  ),
]
