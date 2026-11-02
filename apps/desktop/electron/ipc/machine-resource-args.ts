import { IPC_SCOPE, type MachineChannel } from '@shared/ipc-scope'
import type { IpcInvokeChannel, IpcInvokeMap } from '@shared/ipc'

/**
 * Which arguments of each machine channel name a local resource: a workspace,
 * file, session, process or account binding. Only these positions are checked
 * for an opaque `host:` workspace key or a `remote-<16 hex>` lane handle before
 * a local handler runs. Everything else (file content, terminal input, commit
 * messages, routine instructions, labels, HTML, configs and patches) is never
 * inspected. See docs/remote-desktop.md.
 */

/** At most this many keys in one selected array argument. */
export const MAX_SELECTED_KEYS = 4096

/** One resource position: an argument, a field of an options argument, or each array item. */
export interface ResourceSelector {
  readonly arg: number
  readonly field?: string
  /** The type lets this key be undefined, which then passes. */
  readonly optional?: true
  /** The argument is an array of keys. */
  readonly each?: true
}

type Index<A extends readonly unknown[]> = Extract<keyof A, `${number}`>
type Position<K> = K extends `${infer N extends number}` ? N : never

/** A selector that sets only the options it names; the others must stay absent. */
type Exact<S> = S & { readonly [K in Exclude<'field' | 'optional' | 'each', keyof S>]?: never }

type KeySelector<T, Base> = [T] extends [string]
  ? Exact<Base>
  : [T] extends [string | undefined]
    ? Exact<Base & { readonly optional: true }>
    : never

type FieldSelectors<T, Arg extends number> = [T] extends [readonly unknown[]]
  ? never
  : [T] extends [object]
    ? {
        [F in keyof T & string]-?: KeySelector<T[F], { readonly arg: Arg; readonly field: F }>
      }[keyof T & string]
    : never

type SelectorsAt<T, Arg extends number> =
  | KeySelector<T, { readonly arg: Arg }>
  | ([T] extends [readonly string[]] ? Exact<{ readonly arg: Arg; readonly each: true }> : never)
  | FieldSelectors<T, Arg>

/** The selectors an argument tuple allows: only positions whose type is a string key. */
export type ArgSelectors<A extends readonly unknown[]> = {
  [K in Index<A>]-?: SelectorsAt<A[K], Position<K>>
}[Index<A>]

/** 'none': no argument names a local resource. Otherwise, every position that does. */
export type ResourcePolicy<A extends readonly unknown[]> =
  'none' | readonly [ArgSelectors<A>, ...ArgSelectors<A>[]]

/** Main routes these by session handle before any local registry lookup. */
type RoutedPiChannel =
  'pi:command' | 'pi:extensionUiResponse' | 'pi:disposeSession' | 'pi:listLiveSessions'

export type MachineResourcePolicies = {
  readonly [C in MachineChannel]: C extends RoutedPiChannel
    ? 'routed-pi'
    : ResourcePolicy<IpcInvokeMap[C]['args']>
}

export const MACHINE_RESOURCE_ARGS: MachineResourcePolicies = {
  // Explicit Host ids are authenticated by their handlers; they are not local keys.
  'hosts:models': 'none',
  'hosts:claude': 'none',
  'hosts:claudeUsage': 'none',
  'hosts:providers': 'none',
  'hosts:repositoryFiles': 'none',
  'hosts:repositoryFile': [{ arg: 2 }],
  'hosts:skills': 'none',
  'routines:list': [{ arg: 0, optional: true }],
  'routines:save': [
    { arg: 0, field: 'workspacePath' },
    { arg: 1, optional: true },
    { arg: 3, optional: true },
  ],
  'routines:check': [{ arg: 0, field: 'workspacePath' }],
  'routines:history': [{ arg: 0 }],
  'routines:laneIndex': 'none',
  'routines:promoteRun': [{ arg: 0 }],
  'routines:run': [{ arg: 0 }],
  'routines:cancel': [{ arg: 0 }],
  'routines:skipNext': [{ arg: 0 }],
  'routines:archive': [{ arg: 0 }],
  'routines:delete': [{ arg: 0 }],
  'routines:pauseAll': [{ arg: 0, optional: true }],
  'routines:background': 'none',
  'pi:health': 'none',
  'pi:createSession': [
    { arg: 0, field: 'workspacePath' },
    { arg: 0, field: 'sessionPath', optional: true },
    { arg: 0, field: 'forkFrom', optional: true },
  ],
  'pi:command': 'routed-pi',
  'pi:extensionUiResponse': 'routed-pi',
  'pi:disposeSession': 'routed-pi',
  'pi:listLiveSessions': 'routed-pi',
  'pi:generateTitle': [{ arg: 0 }],
  'pi:agentSettings': [{ arg: 0, optional: true }],
  'pi:agentSettingsScoped': [{ arg: 0, optional: true }],
  'pi:commands': [{ arg: 0, optional: true }],
  'pi:catalogueModels': 'none',
  'pi:readConfigFile': 'none',
  'pi:writeConfigFile': 'none',
  'pi:readInstructions': 'none',
  'pi:writeInstructions': 'none',
  'pi:webSearchConfig': 'none',
  'pi:patchWebSearchConfig': 'none',
  'pi:patchAgentSettings': [{ arg: 1, optional: true }],
  'pi:checkAgentSettings': [{ arg: 0, optional: true }],
  'pi:listResources': 'none',
  'pi:subscriptionAuth': 'none',
  'pi:codexUsage': 'none',
  'pi:loginTerminal': 'none',
  'pi:startLogin': 'none',
  'pi:cancelLogin': 'none',
  'app:selectFolder': 'none',
  'app:createSandbox': 'none',
  'app:listSandboxes': 'none',
  'app:renameSandbox': [{ arg: 0 }],
  'app:deleteSandbox': [{ arg: 0 }],
  'app:resumeTarget': 'none',
  'app:userInfo': 'none',
  'app:saveDialog': [{ arg: 0, field: 'defaultPath', optional: true }],
  'app:revealPath': [{ arg: 0 }],
  'artifacts:stageHtml': 'none',
  'artifacts:exportPdf': 'none',
  'artifacts:forSession': [{ arg: 0 }],
  'artifacts:list': [{ arg: 0, each: true }],
  'artifacts:read': [{ arg: 0 }],
  'artifacts:remove': [{ arg: 0 }],
  'skills:list': [{ arg: 0, optional: true }],
  'skills:restoreBundled': 'none',
  'skills:readFile': [{ arg: 0 }, { arg: 1 }],
  'skills:create': [{ arg: 0, field: 'workspacePath', optional: true }],
  'skills:writeFile': [{ arg: 0 }, { arg: 1 }, { arg: 3, optional: true }],
  'skills:delete': [{ arg: 0 }, { arg: 1, optional: true }],
  'skills:export': [{ arg: 0 }],
  'skills:install': 'none',
  'skills:importPick': 'none',
  'skills:importConfirm': [
    { arg: 0, field: 'sourcePath' },
    { arg: 0, field: 'workspacePath', optional: true },
  ],
  'packages:list': [{ arg: 0, optional: true }],
  'packages:run': [{ arg: 3, optional: true }],
  'packages:installPi': 'none',
  'packages:detect': 'none',
  'packages:checkUpdates': [{ arg: 0, optional: true }],
  'packages:claudeStatus': 'none',
  'packages:claudeCliLatest': 'none',
  'packages:updateClaudeCli': 'none',
  'packages:testClaudeProvider': 'none',
  'claude:startLogin': 'none',
  'claude:submitCode': 'none',
  'claude:cancelLogin': 'none',
  'claude:logout': 'none',
  'claude:accounts': 'none',
  'claude:removeAccount': 'none',
  'claude:reorderAccounts': 'none',
  'claude:setRouting': 'none',
  'claude:refreshAccountUsage': 'none',
  'claude:bindSession': [{ arg: 0 }, { arg: 1 }],
  'claude:assignSession': [{ arg: 0 }],
  'claude:accountSessions': 'none',
  'claude:sessionAccount': [{ arg: 0 }, { arg: 1, optional: true }],
  'claude:usageSnapshot': 'none',
  'mcp:readConfigs': [{ arg: 0, optional: true }],
  'mcp:upsertServer': [{ arg: 1, optional: true }],
  'mcp:removeServer': [{ arg: 1, optional: true }],
  'mcp:setEnabled': [{ arg: 1, optional: true }],
  'mcp:list': [{ arg: 0, optional: true }],
  'mcp:readChecks': [{ arg: 0, optional: true }],
  'mcp:checkServer': [{ arg: 1, optional: true }],
  'mcp:cancelCheck': 'none',
  'mcp:laneControl': [{ arg: 0 }],
  'mcp:setExposure': [{ arg: 1, optional: true }],
  'mcp:authorize': [{ arg: 1, optional: true }],
  'mcp:cancelAuth': 'none',
  'mcp:logout': [{ arg: 1, optional: true }],
  'mcp:migrationPlan': [{ arg: 0, optional: true }],
  'mcp:migrate': [{ arg: 0, optional: true }],
  'mcp:readFile': [{ arg: 1, optional: true }],
  'mcp:writeFile': [{ arg: 1, optional: true }],
  'sessions:list': [{ arg: 0 }],
  'sessions:setCompleted': [{ arg: 0 }],
  'sessions:retainedWorkspaces': [{ arg: 0 }],
  'sessions:restoreWorktree': [{ arg: 0 }],
  'sessions:worktreeRecovery': [{ arg: 0 }],
  'sessions:recreateWorktree': [{ arg: 0 }],
  'sessions:stats': [{ arg: 0 }],
  'sessions:watch': [{ arg: 0 }],
  'sessions:unwatch': [{ arg: 0 }],
  'sessions:delete': [
    { arg: 0, optional: true },
    { arg: 1, optional: true },
  ],
  'sessions:readTree': [{ arg: 0 }],
  'sessions:readTranscript': [{ arg: 0 }],
  'sessions:appendLabel': [{ arg: 0 }],
  'sessions:jump': [{ arg: 0 }],
  'sessions:forkAt': [{ arg: 0 }],
  'sessions:claudeSessionId': [{ arg: 0 }],
  'sessions:forkClaudeLedger': [{ arg: 0 }],
  'gh:prForBranch': [{ arg: 0 }],
  'gh:prsForRepo': [{ arg: 0 }],
  'gh:available': 'none',
  'git:info': [{ arg: 0 }],
  'git:infoBatch': [{ arg: 0, each: true }],
  'git:statusMap': [{ arg: 0 }],
  'git:sessionBaseline': [{ arg: 0 }],
  'git:showFileAt': [{ arg: 0 }, { arg: 2 }],
  'git:restoreFileTo': [{ arg: 0 }, { arg: 2 }],
  'git:listWorktrees': [{ arg: 0 }],
  'git:listBranches': [{ arg: 0 }],
  'git:startPoint': [{ arg: 0 }],
  'git:addWorktree': [{ arg: 0 }],
  'git:removeWorktree': [{ arg: 0 }, { arg: 1 }],
  'git:renameBranch': [{ arg: 0 }],
  'git:pruneWorktrees': [{ arg: 0 }],
  'git:commitAll': [{ arg: 0 }],
  'git:mergeBranch': [{ arg: 0 }],
  'git:fetch': [{ arg: 0 }],
  'git:pull': [{ arg: 0 }],
  'git:updateFromMain': [{ arg: 0 }],
  'git:checkoutBranch': [{ arg: 0 }],
  'maintenance:scan': 'none',
  'maintenance:run': 'none',
  'headroom:status': 'none',
  'headroom:setEnabled': 'none',
  'headroom:start': 'none',
  'headroom:stop': 'none',
  'headroom:install': 'none',
  'optimization:stats': [{ arg: 0 }],
  'fs:listFiles': [{ arg: 0 }],
  'fs:readDir': [{ arg: 0 }, { arg: 1 }],
  'fs:readFile': [{ arg: 0 }],
  'fs:previewUrl': [{ arg: 0 }, { arg: 1 }],
  'fs:openInDefaultApp': [{ arg: 0 }],
  'fs:quickLook': [{ arg: 0 }],
  'fs:writeFile': [{ arg: 0 }],
  'fs:createFile': [{ arg: 0 }],
  'fs:createDir': [{ arg: 0 }],
  'fs:rename': [{ arg: 0 }, { arg: 1 }],
  'fs:trash': [{ arg: 0 }],
  'fs:transfer': [{ arg: 0 }, { arg: 1 }, { arg: 2 }],
  'fs:pickEntries': 'none',
  'fs:watchWorkspace': [{ arg: 0 }],
  'fs:statDirs': [{ arg: 0, each: true }],
  'fs:searchWorkspace': [{ arg: 0, field: 'workspacePath' }],
  'fs:cancelWorkspaceSearch': 'none',
  'pty:create': [{ arg: 0 }, { arg: 3, optional: true }],
  'pty:attach': [{ arg: 0 }],
  'pty:write': [{ arg: 0 }],
  'pty:resize': [{ arg: 0 }],
  'pty:kill': [{ arg: 0 }],
}

const REMOTE_HANDLE = /^remote-[0-9a-f]{16}$/

/** A string naming a local resource, or undefined where the type allows it. */
function localKey(value: unknown, optional: boolean): boolean {
  if (value === undefined) return optional
  return typeof value === 'string' && !value.startsWith('host:') && !REMOTE_HANDLE.test(value)
}

function isOptionsObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function selectsLocalKey(selector: ResourceSelector, args: readonly unknown[]): boolean {
  const value = args[selector.arg]
  if (selector.each) {
    if (!Array.isArray(value) || value.length > MAX_SELECTED_KEYS) return false
    for (let i = 0; i < value.length; i++) if (!localKey(value[i], false)) return false
    return true
  }
  const optional = selector.optional === true
  if (selector.field === undefined) return localKey(value, optional)
  if (!isOptionsObject(value)) return false
  const own = Object.hasOwn(value, selector.field) ? value[selector.field] : undefined
  return localKey(own, optional)
}

function isMachineChannel(channel: IpcInvokeChannel): channel is MachineChannel {
  return IPC_SCOPE[channel] === 'machine'
}

/**
 * True when a local handler must not see this call: a selected position names a
 * remote workspace or lane handle, or is not the key its type promises. App
 * channels and the routed pi channels are never inspected.
 */
export function refusesMachineResourceArgs(
  channel: IpcInvokeChannel,
  args: readonly unknown[],
): boolean {
  if (!isMachineChannel(channel)) return false
  const policy: 'none' | 'routed-pi' | readonly ResourceSelector[] = MACHINE_RESOURCE_ARGS[channel]
  if (policy === 'none' || policy === 'routed-pi') return false
  return !policy.every((selector) => selectsLocalKey(selector, args))
}
