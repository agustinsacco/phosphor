import { expect, expectTypeOf, it } from 'vitest'
import type { IpcInvokeChannel } from './ipc'
import { IPC_SCOPE, type MachineChannel } from './ipc-scope'

it('lists the reviewed machine surface; everything else is app-local', () => {
  const machine = {
    hosts: 'models claude claudeUsage providers skills repositoryFiles repositoryFile',
    routines:
      'list save check history laneIndex promoteRun run cancel skipNext archive delete pauseAll background',
    pi: 'health createSession command extensionUiResponse disposeSession listLiveSessions generateTitle agentSettings agentSettingsScoped commands catalogueModels readConfigFile writeConfigFile webSearchConfig patchWebSearchConfig patchAgentSettings checkAgentSettings listResources subscriptionAuth codexUsage loginTerminal startLogin cancelLogin',
    app: 'resumeTarget selectFolder createSandbox listSandboxes renameSandbox deleteSandbox userInfo saveDialog revealPath',
    artifacts: 'stageHtml exportPdf forSession list read remove',
    fs: 'listFiles readDir readFile previewUrl openInDefaultApp quickLook writeFile createFile createDir rename trash transfer pickEntries watchWorkspace statDirs searchWorkspace cancelWorkspaceSearch',
    skills:
      'list restoreBundled readFile create writeFile delete export install importPick importConfirm',
    packages:
      'list run installPi detect checkUpdates claudeStatus claudeCliLatest updateClaudeCli testClaudeProvider',
    claude:
      'startLogin submitCode cancelLogin logout accounts removeAccount reorderAccounts setRouting refreshAccountUsage bindSession assignSession accountSessions sessionAccount usageSnapshot',
    mcp: 'readConfigs upsertServer removeServer setEnabled list authorize cancelAuth logout migrationPlan migrate readFile writeFile',
    sessions:
      'list stats watch unwatch delete readTree appendLabel jump forkAt claudeSessionId forkClaudeLedger setCompleted retainedWorkspaces restoreWorktree',
    gh: 'prForBranch prsForRepo available',
    git: 'info infoBatch statusMap sessionBaseline showFileAt restoreFileTo listWorktrees listBranches startPoint addWorktree removeWorktree renameBranch pruneWorktrees commitAll mergeBranch fetch pull updateFromMain checkoutBranch',
    maintenance: 'scan run',
    headroom: 'status setEnabled start stop install',
    optimization: 'stats',
    pty: 'create attach write resize kill',
  }
  const expected = Object.entries(machine)
    .flatMap(([prefix, names]) => names.split(' ').map((name) => `${prefix}:${name}`))
    .sort()
  expect(
    Object.entries(IPC_SCOPE)
      .filter(([, scope]) => scope === 'machine')
      .map(([channel]) => channel)
      .sort(),
  ).toEqual(expected)
  expect(Object.values(IPC_SCOPE).every((scope) => scope === 'app' || scope === 'machine')).toBe(
    true,
  )
})

it('keeps each classification literal so MachineChannel derives without widening', () => {
  expectTypeOf<keyof typeof IPC_SCOPE>().toEqualTypeOf<IpcInvokeChannel>()
  expectTypeOf<(typeof IPC_SCOPE)['app:getPrefs']>().toEqualTypeOf<'app'>()
  expectTypeOf<(typeof IPC_SCOPE)['fs:readFile']>().toEqualTypeOf<'machine'>()
  expectTypeOf<'fs:readFile' | 'pi:command' | 'pty:write'>().toExtend<MachineChannel>()
  expectTypeOf<'hosts:openLane'>().not.toExtend<MachineChannel>()
  expectTypeOf<'app:getPrefs'>().not.toExtend<MachineChannel>()
})
