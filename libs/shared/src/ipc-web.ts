import type { IpcInvokeChannel } from './ipc'

export type WebIpcClassification =
  { kind: 'remote-supported' } | { kind: 'browser-local' } | { kind: 'unsupported'; reason: string }

const remote = { kind: 'remote-supported' } as const
const browser = { kind: 'browser-local' } as const
const unsupported = (reason: string) => ({ kind: 'unsupported', reason }) as const

const native = unsupported('This native or mutating Host feature is unavailable in the browser.')

/** Every new IPC channel requires an explicit browser admission decision. */
export const IPC_WEB = {
  'hosts:tailscaleStatus': native,
  'hosts:models': remote,
  'hosts:claude': remote,
  'hosts:claudeUsage': remote,
  'hosts:providers': remote,
  'hosts:repositoryFiles': remote,
  'hosts:repositoryFile': remote,
  'hosts:skills': remote,
  'hosts:providerLogin': native,
  'hosts:settingsAccess': unsupported('Machine configuration requires Desktop.'),
  'hosts:settingsRead': unsupported('Machine configuration requires Desktop.'),
  'hosts:settingsPatch': unsupported('Machine configuration requires Desktop.'),
  'hosts:settingsCheck': unsupported('Machine configuration requires Desktop.'),
  'hosts:machineTask': unsupported('Machine configuration requires Desktop.'),
  'hosts:claudeAccount': unsupported('Machine configuration requires Desktop.'),
  'hosts:uploadAttachments': native,
  'hosts:snapshot': remote,
  'hosts:reconnect': remote,
  'hosts:traffic': native,
  'hosts:setFocusedLane': remote,
  'hosts:openLane': remote,
  'hosts:createLane': remote,
  'hosts:stopLane': remote,
  'hosts:resumeLane': remote,
  'hosts:takeControl': remote,
  'hosts:markRead': remote,
  'hosts:deleteLane': native,
  'hosts:listFolders': remote,
  'hosts:addRepository': remote,
  'hosts:createFolder': remote,
  'hosts:removeRepository': native,
  'hosts:releaseControl': remote,
  'routines:list': remote,
  'routines:save': remote,
  'routines:check': unsupported(
    'Local routine execution and native background services require Desktop.',
  ),
  'routines:history': remote,
  'routines:laneIndex': unsupported(
    'Local routine execution and native background services require Desktop.',
  ),
  'routines:promoteRun': unsupported(
    'Local routine execution and native background services require Desktop.',
  ),
  'routines:run': remote,
  'routines:cancel': remote,
  'routines:skipNext': remote,
  'routines:archive': remote,
  'routines:delete': remote,
  'routines:pauseAll': remote,
  'routines:background': unsupported(
    'Local routine execution and native background services require Desktop.',
  ),
  'pi:health': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:createSession': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:command': remote,
  'pi:extensionUiResponse': remote,
  'pi:disposeSession': remote,
  'pi:listLiveSessions': remote,
  'pi:generateTitle': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'app:getPrefs': browser,
  'app:setTheme': browser,
  'app:selectFolder': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:createSandbox': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:listSandboxes': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:renameSandbox': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:deleteSandbox': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'artifacts:stageHtml': browser,
  'artifacts:exportPdf': unsupported(
    'Artifact deletion and native PDF export are unavailable in the browser.',
  ),
  'artifacts:forSession': remote,
  'artifacts:list': remote,
  'artifacts:read': remote,
  'artifacts:remove': unsupported(
    'Artifact deletion and native PDF export are unavailable in the browser.',
  ),
  'app:setPinnedSessions': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:setRewoundSessions': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:setSessionOrder': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:setLaneMarkers': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:setLanePrefs': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:setModelPicks': browser,
  'app:setLastSession': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:resumeTarget': browser,
  'app:setFontPrefs': browser,
  'app:setWorktreePrefs': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:setAgentDirectives': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:setContextBudget': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:setContextFile': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:setRecentWorkspaces': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:debugLogPath': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:revealDebugLog': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:setCollapsedWorkspaces': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:recordWorkspace': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:markSessionSeen': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:setDraft': browser,
  'app:clearDraft': browser,
  'app:writeDraftBlob': browser,
  'app:readDraftBlob': browser,
  'app:sweepDrafts': browser,
  'app:userInfo': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:about': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:saveDialog': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:revealPath': unsupported(
    'Native settings, local paths and persistent session data are unavailable in the browser.',
  ),
  'app:openExternal': browser,
  'clipboard:writeImage': unsupported(
    'Native file and image clipboard integration is unavailable in the browser.',
  ),
  'clipboard:readImage': unsupported(
    'Native file and image clipboard integration is unavailable in the browser.',
  ),
  'clipboard:writeFiles': unsupported(
    'Native file and image clipboard integration is unavailable in the browser.',
  ),
  'clipboard:readFiles': unsupported(
    'Native file and image clipboard integration is unavailable in the browser.',
  ),
  'writing:setPrefs': unsupported(
    'Native writing integration and prompt learning are unavailable in the browser.',
  ),
  'writing:edit': unsupported(
    'Native writing integration and prompt learning are unavailable in the browser.',
  ),
  'writing:learnWord': unsupported(
    'Native writing integration and prompt learning are unavailable in the browser.',
  ),
  'writing:prompts': unsupported(
    'Native writing integration and prompt learning are unavailable in the browser.',
  ),
  'writing:recordPrompt': unsupported(
    'Native writing integration and prompt learning are unavailable in the browser.',
  ),
  'writing:clearPrompts': unsupported(
    'Native writing integration and prompt learning are unavailable in the browser.',
  ),
  'fs:listFiles': remote,
  'pi:agentSettings': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:agentSettingsScoped': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:commands': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:catalogueModels': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:readConfigFile': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:writeConfigFile': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:webSearchConfig': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:patchWebSearchConfig': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:patchAgentSettings': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:checkAgentSettings': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:listResources': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:subscriptionAuth': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:codexUsage': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:loginTerminal': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:startLogin': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'pi:cancelLogin': unsupported(
    'Local pi processes and machine configuration are unavailable in the browser.',
  ),
  'skills:list': remote,
  'skills:restoreBundled': unsupported('This native service requires Desktop.'),
  'skills:readFile': remote,
  'skills:create': unsupported('This native service requires Desktop.'),
  'skills:writeFile': unsupported('This native service requires Desktop.'),
  'skills:delete': unsupported('This native service requires Desktop.'),
  'skills:export': unsupported('This native service requires Desktop.'),
  'skills:install': unsupported('This native service requires Desktop.'),
  'skills:importPick': unsupported('This native service requires Desktop.'),
  'skills:importConfirm': unsupported('This native service requires Desktop.'),
  'packages:list': unsupported(
    'Provider installation and native package management require Desktop.',
  ),
  'packages:run': unsupported(
    'Provider installation and native package management require Desktop.',
  ),
  'packages:installPi': unsupported(
    'Provider installation and native package management require Desktop.',
  ),
  'packages:detect': unsupported(
    'Provider installation and native package management require Desktop.',
  ),
  'packages:checkUpdates': unsupported(
    'Provider installation and native package management require Desktop.',
  ),
  'packages:claudeStatus': unsupported(
    'Provider installation and native package management require Desktop.',
  ),
  'packages:claudeCliLatest': unsupported(
    'Provider installation and native package management require Desktop.',
  ),
  'packages:updateClaudeCli': unsupported(
    'Provider installation and native package management require Desktop.',
  ),
  'claude:startLogin': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'claude:submitCode': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'claude:cancelLogin': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'claude:logout': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'control:machines': remote,
  'control:lookupEnrollment': remote,
  'control:approveEnrollment': remote,
  'control:renameMachine': remote,
  'control:removeMachine': remote,
  'account:get': remote,
  'account:signIn': remote,
  'account:cancelSignIn': unsupported('This native service requires Desktop.'),
  'account:signOut': remote,
  'claude:accounts': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'claude:removeAccount': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'claude:reorderAccounts': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'claude:setRouting': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'claude:refreshAccountUsage': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'claude:bindSession': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'claude:assignSession': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'claude:accountSessions': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'claude:sessionAccount': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'claude:usageSnapshot': unsupported(
    'Native provider credentials and processes are not browser-accessible.',
  ),
  'packages:testClaudeProvider': unsupported(
    'Provider installation and native package management require Desktop.',
  ),
  'mcp:readConfigs': unsupported(
    'Connector configuration and credentials belong to the Host or Desktop.',
  ),
  'mcp:upsertServer': unsupported(
    'Connector configuration and credentials belong to the Host or Desktop.',
  ),
  'mcp:removeServer': unsupported(
    'Connector configuration and credentials belong to the Host or Desktop.',
  ),
  'mcp:setEnabled': unsupported(
    'Connector configuration and credentials belong to the Host or Desktop.',
  ),
  'mcp:list': unsupported('Connector configuration and credentials belong to the Host or Desktop.'),
  'mcp:readChecks': unsupported('Use the selected machine’s connector settings.'),
  'mcp:checkServer': unsupported('Use the selected machine’s connector settings.'),
  'mcp:cancelCheck': unsupported('Use the selected machine’s connector settings.'),
  'mcp:laneControl': unsupported('Use the selected machine’s connector settings.'),
  'mcp:setExposure': unsupported('Use the selected machine’s connector settings.'),
  'mcp:authorize': unsupported(
    'Connector configuration and credentials belong to the Host or Desktop.',
  ),
  'mcp:cancelAuth': unsupported(
    'Connector configuration and credentials belong to the Host or Desktop.',
  ),
  'mcp:logout': unsupported(
    'Connector configuration and credentials belong to the Host or Desktop.',
  ),
  'mcp:migrationPlan': unsupported(
    'Connector configuration and credentials belong to the Host or Desktop.',
  ),
  'mcp:migrate': unsupported(
    'Connector configuration and credentials belong to the Host or Desktop.',
  ),
  'mcp:readFile': unsupported(
    'Connector configuration and credentials belong to the Host or Desktop.',
  ),
  'mcp:writeFile': unsupported(
    'Connector configuration and credentials belong to the Host or Desktop.',
  ),
  'sessions:list': unsupported('Local session files and mutations require Desktop.'),
  'sessions:setCompleted': unsupported('Local session maintenance requires Desktop.'),
  'sessions:retainedWorkspaces': unsupported('Local session maintenance requires Desktop.'),
  'sessions:restoreWorktree': unsupported('Local session maintenance requires Desktop.'),
  'sessions:stats': unsupported('Local session files and mutations require Desktop.'),
  'sessions:watch': unsupported('Local session files and mutations require Desktop.'),
  'sessions:unwatch': unsupported('Local session files and mutations require Desktop.'),
  'sessions:delete': unsupported('Local session files and mutations require Desktop.'),
  'sessions:readTree': unsupported('Local session files and mutations require Desktop.'),
  'sessions:appendLabel': unsupported('Local session files and mutations require Desktop.'),
  'sessions:jump': unsupported('Local session files and mutations require Desktop.'),
  'sessions:forkAt': unsupported('Local session files and mutations require Desktop.'),
  'sessions:claudeSessionId': unsupported('Local session files and mutations require Desktop.'),
  'sessions:forkClaudeLedger': unsupported('Local session files and mutations require Desktop.'),
  'gh:prForBranch': unsupported('This native service requires Desktop.'),
  'gh:prsForRepo': remote,
  'gh:available': unsupported('This native service requires Desktop.'),
  'git:info': unsupported('Only Host-scoped read-only status and file comparisons are available.'),
  'git:infoBatch': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'git:statusMap': remote,
  'git:sessionBaseline': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'git:showFileAt': remote,
  'git:restoreFileTo': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'git:listWorktrees': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'git:listBranches': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'git:startPoint': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'git:addWorktree': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'git:removeWorktree': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'git:renameBranch': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'git:pruneWorktrees': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'maintenance:scan': unsupported('This native service requires Desktop.'),
  'maintenance:run': unsupported('This native service requires Desktop.'),
  'maintenance:setPrefs': unsupported('This native service requires Desktop.'),
  'headroom:status': unsupported('This native service requires Desktop.'),
  'headroom:setEnabled': unsupported('This native service requires Desktop.'),
  'headroom:start': unsupported('This native service requires Desktop.'),
  'headroom:stop': unsupported('This native service requires Desktop.'),
  'headroom:install': unsupported('This native service requires Desktop.'),
  'optimization:stats': unsupported('This native service requires Desktop.'),
  'voice:status': unsupported('This native service requires Desktop.'),
  'voice:setPrefs': unsupported('This native service requires Desktop.'),
  'voice:start': unsupported('This native service requires Desktop.'),
  'voice:audio': unsupported('This native service requires Desktop.'),
  'voice:stop': unsupported('This native service requires Desktop.'),
  'voice:cancel': unsupported('This native service requires Desktop.'),
  'git:commitAll': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'git:mergeBranch': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'git:fetch': unsupported('Only Host-scoped read-only status and file comparisons are available.'),
  'git:pull': unsupported('Only Host-scoped read-only status and file comparisons are available.'),
  'git:updateFromMain': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'git:checkoutBranch': unsupported(
    'Only Host-scoped read-only status and file comparisons are available.',
  ),
  'fs:readDir': unsupported('Browser file access is read-only and explicitly Host-scoped.'),
  'fs:readFile': remote,
  'fs:previewUrl': unsupported('Browser file access is read-only and explicitly Host-scoped.'),
  'fs:openInDefaultApp': unsupported(
    'Browser file access is read-only and explicitly Host-scoped.',
  ),
  'fs:quickLook': unsupported('Browser file access is read-only and explicitly Host-scoped.'),
  'fs:writeFile': unsupported('Browser file access is read-only and explicitly Host-scoped.'),
  'fs:createFile': unsupported('Browser file access is read-only and explicitly Host-scoped.'),
  'fs:createDir': unsupported('Browser file access is read-only and explicitly Host-scoped.'),
  'fs:rename': unsupported('Browser file access is read-only and explicitly Host-scoped.'),
  'fs:trash': unsupported('Browser file access is read-only and explicitly Host-scoped.'),
  'fs:transfer': unsupported('Browser file access is read-only and explicitly Host-scoped.'),
  'fs:pickEntries': unsupported('Browser file access is read-only and explicitly Host-scoped.'),
  'fs:watchWorkspace': unsupported('Browser file access is read-only and explicitly Host-scoped.'),
  'fs:statDirs': unsupported('Browser file access is read-only and explicitly Host-scoped.'),
  'fs:searchWorkspace': unsupported('Browser file access is read-only and explicitly Host-scoped.'),
  'fs:cancelWorkspaceSearch': unsupported(
    'Browser file access is read-only and explicitly Host-scoped.',
  ),
  'pty:create': unsupported('Terminals require Desktop.'),
  'pty:attach': unsupported('Terminals require Desktop.'),
  'pty:write': unsupported('Terminals require Desktop.'),
  'pty:resize': unsupported('Terminals require Desktop.'),
  'pty:kill': unsupported('Terminals require Desktop.'),
  'updates:state': unsupported('Native updates require Desktop.'),
  'updates:check': unsupported('Native updates require Desktop.'),
  'updates:restartAndInstall': unsupported('Native updates require Desktop.'),
  'feedback:state': unsupported('This native service requires Desktop.'),
  'feedback:submit': unsupported('This native service requires Desktop.'),
  'feedback:dismiss': unsupported('This native service requires Desktop.'),
} satisfies Record<IpcInvokeChannel, WebIpcClassification>

export type WebSupportedChannel = {
  [C in IpcInvokeChannel]: (typeof IPC_WEB)[C]['kind'] extends 'unsupported' ? never : C
}[IpcInvokeChannel]
