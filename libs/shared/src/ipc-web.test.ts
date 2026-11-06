import { expect, it } from 'vitest'
import { IPC_SCOPE } from './ipc-scope'
import { IPC_WEB } from './ipc-web'
it('characterizes the local pi refusal policy before consolidating repeated declarations', () => {
  for (const channel of [
    'pi:health',
    'pi:createSession',
    'pi:generateTitle',
    'pi:agentSettings',
    'pi:agentSettingsScoped',
    'pi:commands',
    'pi:catalogueModels',
    'pi:readConfigFile',
    'pi:writeConfigFile',
    'pi:readInstructions',
    'pi:writeInstructions',
    'pi:webSearchConfig',
    'pi:patchWebSearchConfig',
    'pi:patchAgentSettings',
    'pi:checkAgentSettings',
    'pi:listResources',
    'pi:subscriptionAuth',
    'pi:codexUsage',
    'pi:loginTerminal',
    'pi:startLogin',
    'pi:cancelLogin',
  ] as const)
    expect(IPC_WEB[channel]).toEqual({
      kind: 'unsupported',
      reason: 'Local pi processes and machine configuration are unavailable in the browser.',
    })
  for (const [channel, entry] of Object.entries(IPC_WEB))
    if (channel.startsWith('brain:'))
      expect(entry).toEqual({
        kind: 'unsupported',
        reason: 'Brain is a local Desktop prototype; remote access is unavailable.',
      })
})
it('classifies every invoke channel and gives every refusal a reason', () => {
  expect(Object.keys(IPC_WEB).sort()).toEqual(Object.keys(IPC_SCOPE).sort())
  for (const entry of Object.values(IPC_WEB)) {
    expect(['remote-supported', 'browser-local', 'unsupported']).toContain(entry.kind)
    if (entry.kind === 'unsupported') expect(entry.reason.length).toBeGreaterThan(15)
  }
})
it('keeps lane and branch prefs in the browser, which apply to every Host from this device', () => {
  for (const channel of ['app:setLanePrefs', 'app:setWorktreePrefs'] as const)
    expect(IPC_WEB[channel]).toEqual({ kind: 'browser-local' })
})
it('Host file writes and uploads are remote-supported', () => {
  for (const channel of [
    'fs:writeFile',
    'fs:createFile',
    'fs:createDir',
    'fs:rename',
    'fs:trash',
    'fs:transfer',
    'hosts:uploadAttachments',
  ] as const)
    expect(IPC_WEB[channel]).toEqual({ kind: 'remote-supported' })
})
it("keeps a Host lane's order and a Host folder's collapse in the browser, as Desktop keeps them", () => {
  for (const channel of ['app:setSessionOrder', 'app:setCollapsedWorkspaces'] as const)
    expect(IPC_WEB[channel]).toEqual({ kind: 'browser-local' })
})
