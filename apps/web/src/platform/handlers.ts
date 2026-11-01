import type { IpcInvokeMap } from '@phosphor/shared/ipc'
import type { WebSupportedChannel } from '@phosphor/shared/ipc-web'
import { laneMarks } from '@phosphor/host-client/lane-marks'
import { remoteSkillShare } from '@phosphor/host-client/skill-share'
import type { RemoteLanes, RemoteWindow } from '@phosphor/host-client/remote-lanes'
import type { BrowserControl } from './control'
import type { BrowserHosts } from './hosts'
import type { createBrowserResources } from './resources'
import type { createBrowserPreferences } from './preferences'
import { staticArtifactPreview } from './preview'
import type { createBrowserDrafts } from './drafts'
import type { createBrowserTerminals } from './terminals'
import type { createBrowserSettings } from './settings'

export type BrowserHandlers = {
  [C in WebSupportedChannel]: (
    ...args: IpcInvokeMap[C]['args']
  ) => IpcInvokeMap[C]['result'] | Promise<IpcInvokeMap[C]['result']>
}
/** Machine catalogues and skill sharing: no lane is needed. The browser has no 'local'. */
function machineHandlers(
  machines: ReturnType<typeof createBrowserResources>['machines'],
  connection: BrowserHosts['connection'],
) {
  const share = remoteSkillShare(connection)
  return {
    'hosts:models': machines.models,
    'hosts:claude': machines.claude,
    'hosts:claudeUsage': machines.claudeUsage,
    'hosts:providers': machines.providers,
    'hosts:skills': machines.skills,
    'hosts:skillExport': (source) => share.export(source.machine, source.name),
    'hosts:skillInstall': (machine, bundle, overwrite) =>
      share.install(machine, bundle, overwrite === true),
  } satisfies Partial<BrowserHandlers>
}
/** The Host's folder dialog; the folders are the Host's, so the browser can browse them too. */
function folderHandlers(folders: ReturnType<typeof createBrowserResources>['folders']) {
  return {
    'hosts:listFolders': folders.folders,
    'hosts:createFolder': folders.createFolder,
    'hosts:addRepository': folders.add,
    'hosts:removeRepository': folders.remove,
    'hosts:orderRepositories': folders.order,
  } satisfies Partial<BrowserHandlers>
}
/** Host shells: lane terminals, the Machine page's shell and provider sign-in. */
function terminalHandlers(terminals: ReturnType<typeof createBrowserTerminals>['handlers']) {
  return {
    'pty:create': (...args) => terminals['pty:create'](...args),
    'pty:attach': (...args) => terminals['pty:attach'](...args),
    'pty:write': (...args) => terminals['pty:write'](...args),
    'pty:resize': (...args) => terminals['pty:resize'](...args),
    'pty:kill': (...args) => terminals['pty:kill'](...args),
    'hosts:machineShell': (...args) => terminals['hosts:machineShell'](...args),
    'hosts:providerLogin': (...args) => terminals['hosts:providerLogin'](...args),
    'hosts:machineTask': (...args) => terminals['hosts:machineTask'](...args),
  } satisfies Partial<BrowserHandlers>
}
/** Host machine settings, after the explicit configuration access request. */
function settingsHandlers(settings: () => ReturnType<typeof createBrowserSettings>) {
  return {
    'hosts:settingsAccess': (...args) => settings().access(...args),
    'hosts:settingsRead': (...args) => settings().read(...args),
    'hosts:settingsPatch': (...args) => settings().patch(...args),
    'hosts:settingsCheck': (...args) => settings().check(...args),
    'hosts:claudeAccount': (...args) => settings().moveAccount(...args),
  } satisfies Partial<BrowserHandlers>
}
/** Cross-tab delivery cannot prevent local logout. */
function signOut(control: BrowserControl, broadcast: () => void) {
  const result = control.signOut()
  try {
    broadcast()
  } catch {
    // Local invalidation still takes effect if the browser channel is unavailable.
  }
  return result
}
export function createBrowserHandlers(ports: {
  control: BrowserControl
  hosts: BrowserHosts
  lanes: RemoteLanes
  window: () => RemoteWindow
  resources: ReturnType<typeof createBrowserResources>
  terminals: ReturnType<typeof createBrowserTerminals>['handlers']
  settings: ReturnType<typeof createBrowserSettings>
  prefs: ReturnType<typeof createBrowserPreferences>
  drafts: ReturnType<typeof createBrowserDrafts>
  openExternal: (url: string) => void
  broadcastLogout: () => void
  machinesChanged: () => void
}): BrowserHandlers {
  const { control, hosts, lanes, resources, prefs, drafts } = ports
  const marks = laneMarks(hosts.connection)
  const read = <C extends WebSupportedChannel>(channel: C, args: IpcInvokeMap[C]['args']) =>
    resources.read(channel, args) as Promise<IpcInvokeMap[C]['result']>
  const routine = <C extends WebSupportedChannel>(channel: C, args: IpcInvokeMap[C]['args']) =>
    resources.routine(channel, args) as Promise<IpcInvokeMap[C]['result']>
  async function directoryMutation<T>(request: Promise<T>): Promise<T> {
    const result = await request
    await hosts.refresh().catch(() => {})
    ports.machinesChanged()
    return result
  }
  return {
    'account:get': control.view,
    'account:signIn': control.signIn,
    'account:signOut': () => signOut(control, ports.broadcastLogout),
    'control:machines': hosts.refresh,
    'control:lookupEnrollment': control.lookup,
    'control:approveEnrollment': (code, label) => directoryMutation(control.approve(code, label)),
    'control:renameMachine': (id, label) => directoryMutation(control.rename(id, label)),
    'control:removeMachine': (id) => directoryMutation(control.remove(id)),
    ...machineHandlers(resources.machines, hosts.connection),
    ...folderHandlers(resources.folders),
    ...terminalHandlers(ports.terminals),
    ...settingsHandlers(() => ports.settings),
    'gh:prsForRepo': resources.repositories.pullRequests,
    'hosts:repositoryFiles': resources.repositories.list,
    'hosts:repositoryFile': resources.repositories.read,
    'hosts:snapshot': hosts.snapshot,
    'hosts:reconnect': hosts.reconnect,
    'hosts:setFocusedLane': (target) => lanes.setFocused(1, target),
    'hosts:openLane': (host, lane) => lanes.open(ports.window(), host, lane),
    'hosts:createLane': (host, input) => lanes.create(ports.window(), host, input),
    'hosts:stopLane': (host, lane) => lanes.action(host, lane, 'lane.stop'),
    'hosts:resumeLane': (host, lane) => lanes.action(host, lane, 'lane.resume'),
    'hosts:takeControl': (host, lane) => lanes.action(host, lane, 'control.take'),
    'hosts:releaseControl': (host, lane) => lanes.action(host, lane, 'control.release'),
    'hosts:markRead': (host, lane) => lanes.action(host, lane, 'lane.markRead'),
    'hosts:setLaneMarks': marks.set,
    'hosts:deleteLane': (host, lane, options) => resources.folders.deleteLane(host, lane, options),
    'pi:command': (id, command) => lanes.command(1, id, command),
    'pi:extensionUiResponse': (id, response) => lanes.respond(1, id, response),
    'pi:disposeSession': (id) => lanes.dispose(1, id),
    'pi:listLiveSessions': () => lanes.list(1),
    'fs:listFiles': (key) => read('fs:listFiles', [key]),
    'fs:readFile': (key) => read('fs:readFile', [key]),
    'git:statusMap': (key) => read('git:statusMap', [key]),
    'git:showFileAt': (key, ref, path) => read('git:showFileAt', [key, ref, path]),
    'skills:list': (key) => read('skills:list', [key]),
    'skills:readFile': (key, path) => read('skills:readFile', [key, path]),
    'artifacts:forSession': resources.sessionArtifacts,
    'artifacts:list': (paths) => {
      if (
        !Array.isArray(paths) ||
        paths.length > 2000 ||
        paths.some(
          (path) =>
            typeof path !== 'string' || (!path.startsWith('host:') && !path.startsWith('remote-')),
        )
      )
        throw new Error('Local artifact paths are unavailable.')
      return resources.artifacts()
    },
    'artifacts:read': resources.artifact,
    'artifacts:stageHtml': (html) => staticArtifactPreview(html),
    'routines:list': (machine) => routine('routines:list', [machine]),
    'routines:save': (...args) => routine('routines:save', args),
    'routines:history': (...args) => routine('routines:history', args),
    'routines:run': (...args) => routine('routines:run', args),
    'routines:cancel': (...args) => routine('routines:cancel', args),
    'routines:skipNext': (...args) => routine('routines:skipNext', args),
    'routines:archive': (...args) => routine('routines:archive', args),
    'routines:delete': (...args) => routine('routines:delete', args),
    'routines:pauseAll': (...args) => routine('routines:pauseAll', args),
    'app:getPrefs': () => ({ ...prefs.get(), drafts: drafts.snapshot() }),
    'app:setDraft': drafts.set,
    'app:clearDraft': drafts.clear,
    'app:writeDraftBlob': drafts.writeBlob,
    'app:readDraftBlob': drafts.readBlob,
    'app:sweepDrafts': drafts.sweep,
    'app:setTheme': prefs.theme,
    'app:setFontPrefs': prefs.fonts,
    'app:setModelPicks': prefs.models,
    'app:resumeTarget': () => ({ kind: 'none' }),
    'app:openExternal': (value) => {
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Only HTTPS links can be opened.')
      ports.openExternal(url.href)
    },
  }
}
