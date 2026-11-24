/**
 * `owner.migrate.import` sections: This Mac's in-app state, staged by the daemon
 * until commit. A section replays as a no-op when its `hash` matches what is
 * staged. Unknown keys are dropped, so either side can add an optional field.
 * Reached through `../host-protocol-owner`.
 */
import { isSha256Hex, isUuid } from '../control-api'
import { isLaneMarker } from '../host-protocol-lane-marks'
import { integer, member, record, text } from '../host-protocol/primitives'
import type { AgentDirectivePrefs } from '../models/directives'
import type { ClaudeAccount, ClaudeRoutingMode } from '../models/providers'
import type { ContextFilePrefs } from '../context-files'
import {
  MIGRATION_LIMITS,
  dict,
  isOwnerPath,
  isTrue,
  list,
  optionalPath,
  parseMigrationAccount,
  parseMigrationArchiveManifest,
  parseMigrationLaneItem,
  type MigrationArchiveManifest,
  type MigrationLaneItem,
} from './migration-items'

export { MIGRATION_LIMITS } from './migration-items'
export type { MigrationArchiveManifest, MigrationLaneItem } from './migration-items'

export type MigrationSection =
  | {
      readonly section: 'folders'
      readonly items: readonly {
        readonly path: string
        readonly name: string
        readonly sandbox?: true
        readonly order: number
      }[]
      readonly sandboxRoot?: string
    }
  | {
      readonly section: 'policy'
      readonly contextBudget: string
      readonly agentDirectives: AgentDirectivePrefs
      readonly directivesByFolder: Readonly<Record<string, AgentDirectivePrefs>>
      readonly autoNameLanes: boolean
      readonly contextFiles: ContextFilePrefs
      readonly headroom: boolean
    }
  | {
      readonly section: 'accounts'
      /** Desktop's `<userData>/claude-accounts`; every `credentialDir` is a UUID folder in it. */
      readonly accountRoot: string
      readonly accounts: readonly ClaudeAccount[]
      readonly mode: ClaudeRoutingMode
      readonly pinnedId?: string
      readonly cursor: number
      readonly cooldowns: Readonly<Record<string, number>>
      /** Only bindings whose session file still exists (Desktop's `tidy` rule). */
      readonly bindings: Readonly<Record<string, string>>
    }
  | { readonly section: 'lanes'; readonly items: readonly MigrationLaneItem[] }
  | {
      readonly section: 'marks'
      /** `unread` imports as `attention = read + 1`. */
      readonly items: readonly {
        readonly sessionFile: string
        readonly pinned?: true
        readonly marker?: string
        readonly unread?: true
      }[]
      readonly rewound: Readonly<Record<string, string>>
    }
  | { readonly section: 'archives'; readonly manifests: readonly MigrationArchiveManifest[] }
  | { readonly section: 'artifacts'; readonly sourceDir: string }
  | {
      readonly section: 'routines'
      /** A consistent copy whose definitions and run rows carry realpathed `workspacePath`s. */
      readonly database: string
      /** Those realpaths; each must be a migrated folder. */
      readonly workspaces: readonly string[]
    }

export type MigrationImport = {
  readonly migrationId: string
  readonly hash: string
} & MigrationSection

const directives = (v: unknown): v is AgentDirectivePrefs =>
  record(v) &&
  ['machineAwareness', 'worktreeGuard', 'laneCharter', 'subagentPolicy'].every(
    (k) => typeof v[k] === 'boolean',
  )
const directivesOf = (v: AgentDirectivePrefs): AgentDirectivePrefs => ({
  machineAwareness: v.machineAwareness,
  worktreeGuard: v.worktreeGuard,
  laneCharter: v.laneCharter,
  subagentPolicy: v.subagentPolicy,
})

function accounts(v: Record<string, unknown>): MigrationSection | null {
  const root = v.accountRoot
  if (!isOwnerPath(root)) return null
  const all = list(v.accounts, MIGRATION_LIMITS.accounts, (x) => parseMigrationAccount(x, root))
  if (!all || new Set(all.map((a) => a.id)).size !== all.length) return null
  const known = (id: unknown): id is string => all.some((a) => a.id === id)
  const cooldowns = dict(v.cooldowns, MIGRATION_LIMITS.accounts, known, integer)
  const bindings = dict(v.bindings, MIGRATION_LIMITS.lanes, isOwnerPath, known)
  if (
    !cooldowns ||
    !bindings ||
    !member(v.mode, ['specific', 'ordered', 'round-robin']) ||
    (v.pinnedId !== undefined && !known(v.pinnedId)) ||
    !integer(v.cursor)
  )
    return null
  return {
    section: 'accounts',
    accountRoot: root,
    accounts: all,
    mode: v.mode,
    ...(known(v.pinnedId) ? { pinnedId: v.pinnedId } : {}),
    cursor: v.cursor,
    cooldowns,
    bindings,
  }
}

export function parseMigrationFolders(
  v: Record<string, unknown>,
): Extract<MigrationSection, { section: 'folders' }> | null {
  const items = list(v.items, MIGRATION_LIMITS.folders, (x) =>
    record(x) && isOwnerPath(x.path) && text(x.name, 200) && isTrue(x.sandbox) && integer(x.order)
      ? {
          path: x.path,
          name: x.name,
          order: x.order,
          ...(x.sandbox ? { sandbox: true as const } : {}),
        }
      : null,
  )
  if (!items || !optionalPath(v.sandboxRoot)) return null
  return {
    section: 'folders',
    items,
    ...(isOwnerPath(v.sandboxRoot) ? { sandboxRoot: v.sandboxRoot } : {}),
  }
}

function policy(v: Record<string, unknown>): MigrationSection | null {
  const byFolder = dict(v.directivesByFolder, MIGRATION_LIMITS.folders, isOwnerPath, directives)
  const files = v.contextFiles
  if (
    !byFolder ||
    typeof v.contextBudget !== 'string' ||
    v.contextBudget.length > 32 ||
    !directives(v.agentDirectives) ||
    typeof v.autoNameLanes !== 'boolean' ||
    !record(files) ||
    typeof files.claude !== 'boolean' ||
    typeof files.agents !== 'boolean' ||
    typeof v.headroom !== 'boolean'
  )
    return null
  return {
    section: 'policy',
    contextBudget: v.contextBudget,
    agentDirectives: directivesOf(v.agentDirectives),
    directivesByFolder: Object.fromEntries(
      Object.entries(byFolder).map(([path, prefs]) => [path, directivesOf(prefs)]),
    ),
    autoNameLanes: v.autoNameLanes,
    contextFiles: { claude: files.claude, agents: files.agents },
    headroom: v.headroom,
  }
}

function marks(v: Record<string, unknown>): MigrationSection | null {
  const items = list(v.items, MIGRATION_LIMITS.lanes, (x) =>
    record(x) &&
    isOwnerPath(x.sessionFile) &&
    isTrue(x.pinned) &&
    isTrue(x.unread) &&
    (x.marker === undefined || isLaneMarker(x.marker))
      ? {
          sessionFile: x.sessionFile,
          ...(x.pinned ? { pinned: true as const } : {}),
          ...(isLaneMarker(x.marker) ? { marker: x.marker } : {}),
          ...(x.unread ? { unread: true as const } : {}),
        }
      : null,
  )
  const rewound = dict(v.rewound, MIGRATION_LIMITS.lanes, isOwnerPath, isOwnerPath)
  return items && rewound ? { section: 'marks', items, rewound } : null
}

function section(v: Record<string, unknown>): MigrationSection | null {
  switch (v.section) {
    case 'folders':
      return parseMigrationFolders(v)
    case 'policy':
      return policy(v)
    case 'accounts':
      return accounts(v)
    case 'lanes': {
      const items = list(v.items, MIGRATION_LIMITS.lanes, parseMigrationLaneItem)
      return items && new Set(items.map((i) => i.laneId)).size === items.length
        ? { section: 'lanes', items }
        : null
    }
    case 'marks':
      return marks(v)
    case 'archives': {
      const manifests = list(v.manifests, MIGRATION_LIMITS.archives, parseMigrationArchiveManifest)
      return manifests ? { section: 'archives', manifests } : null
    }
    case 'artifacts':
      return isOwnerPath(v.sourceDir) ? { section: 'artifacts', sourceDir: v.sourceDir } : null
    case 'routines': {
      const workspaces = list(v.workspaces, MIGRATION_LIMITS.folders, (x) =>
        isOwnerPath(x) ? x : null,
      )
      return isOwnerPath(v.database) && workspaces
        ? { section: 'routines', database: v.database, workspaces }
        : null
    }
    default:
      return null
  }
}

export function parseMigrationImport(v: unknown): MigrationImport | null {
  if (!record(v) || !isUuid(v.migrationId) || !isSha256Hex(v.hash)) return null
  const s = section(v)
  return s ? { migrationId: v.migrationId, hash: v.hash, ...s } : null
}
