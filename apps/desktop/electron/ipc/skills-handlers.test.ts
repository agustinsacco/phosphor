import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcInvokeChannel, IpcInvokeMap } from '@shared/ipc'
import { MIN_PI_VERSION, type PiHealth } from '@shared/models'
import { registerSkillsHandlers } from './skills-handlers'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  app: { isPackaged: false },
  window: {},
  save: vi.fn(),
  open: vi.fn(),
  write: vi.fn(),
  health: vi.fn<() => Promise<PiHealth>>(),
  env: vi.fn(),
  invalidate: vi.fn(),
  restore: vi.fn(),
  skills: {
    resolveSkills: vi.fn(),
    readSkillFileEntry: vi.fn(),
    createSkill: vi.fn(),
    writeSkillFileEntry: vi.fn(),
    deleteSkill: vi.fn(),
    buildSkillZip: vi.fn(),
    installCatalogSkill: vi.fn(),
    previewSkillImport: vi.fn(),
    confirmSkillImport: vi.fn(),
  },
}))
vi.mock('./handle', () => ({
  handle: (channel: string, handler: Handler) => h.handlers.set(channel, handler),
}))
vi.mock('electron', () => ({
  app: h.app,
  BrowserWindow: { fromWebContents: vi.fn(() => h.window) },
  dialog: { showSaveDialog: h.save, showOpenDialog: h.open },
}))
vi.mock('node:fs/promises', () => ({ writeFile: h.write }))
vi.mock('../pi/health', () => ({ cachedPiHealth: h.health }))
vi.mock('../pi/shell-env', () => ({ piProcessEnv: h.env }))
vi.mock('../pi/catalogue', () => ({ invalidatePiCommands: h.invalidate }))
vi.mock('./pi-config-handlers', () => ({ invalidatePiCommands: h.invalidate }))
vi.mock('../pi/session-launch', () => ({ ensureDesktopArtifactSkill: h.restore }))
vi.mock('../pi/skills', () => h.skills)

function invoke<C extends IpcInvokeChannel>(channel: C, ...args: IpcInvokeMap[C]['args']) {
  const handler = h.handlers.get(channel)
  if (!handler) throw new Error(`unregistered channel: ${channel}`)
  return Promise.resolve().then(() => handler({ sender: {} }, ...args))
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('PHOSPHOR_PI_STUB', '')
  h.app.isPackaged = false
  h.health.mockResolvedValue({ ok: true, binaryPath: '/bin/pi', minVersion: MIN_PI_VERSION })
  h.env.mockResolvedValue({ PATH: '/shell/bin' })
  h.skills.resolveSkills.mockResolvedValue({ skills: [], probe: 'scan' })
  h.skills.buildSkillZip.mockResolvedValue({ fileName: 'demo.zip', data: Buffer.from('zip') })
  h.save.mockResolvedValue({ canceled: false, filePath: '/saved.zip' })
  h.open.mockResolvedValue({ canceled: false, filePaths: ['/import.zip'] })
  h.handlers.clear()
  registerSkillsHandlers()
})
afterEach(() => vi.unstubAllEnvs())

describe('skills IPC characterization', () => {
  it('registers exactly the skills channels', () => {
    expect([...h.handlers.keys()]).toEqual([
      'skills:list',
      'skills:restoreBundled',
      'skills:readFile',
      'skills:create',
      'skills:writeFile',
      'skills:delete',
      'skills:export',
      'skills:install',
      'skills:importPick',
      'skills:importConfirm',
    ])
  })

  it('lists with the healthy pi executable, prefix and shell environment', async () => {
    h.health.mockResolvedValue({
      ok: true,
      binaryPath: '/node',
      prefixArgs: ['/pi.js'],
      minVersion: MIN_PI_VERSION,
    })
    const result = { skills: [], probe: 'rpc' }
    h.skills.resolveSkills.mockResolvedValue(result)
    expect(await invoke('skills:list', '/workspace')).toBe(result)
    expect(h.skills.resolveSkills).toHaveBeenCalledWith({
      workspacePath: '/workspace',
      binaryPath: '/node',
      prefixArgs: ['/pi.js'],
      env: { PATH: '/shell/bin' },
    })
  })

  it('omits absent workspace and prefix arguments for real pi', async () => {
    await invoke('skills:list')
    expect(h.skills.resolveSkills).toHaveBeenCalledWith({
      binaryPath: '/bin/pi',
      env: { PATH: '/shell/bin' },
    })
  })

  it('uses only the minimal stub environment without discovering real pi', async () => {
    vi.stubEnv('PHOSPHOR_PI_STUB', '/stub.cjs')
    await invoke('skills:list', '/workspace')
    expect(h.skills.resolveSkills).toHaveBeenCalledWith({
      workspacePath: '/workspace',
      binaryPath: process.execPath,
      prefixArgs: ['/stub.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(h.health).not.toHaveBeenCalled()
    expect(h.env).not.toHaveBeenCalled()
  })

  it('ignores a packaged environment stub', async () => {
    h.app.isPackaged = true
    vi.stubEnv('PHOSPHOR_PI_STUB', '/untrusted.cjs')
    await invoke('skills:list')
    expect(h.skills.resolveSkills).toHaveBeenCalledWith({
      binaryPath: '/bin/pi',
      env: { PATH: '/shell/bin' },
    })
  })

  it('scans without pi or a shell environment when health is unavailable', async () => {
    h.health.mockResolvedValue({ ok: false, reason: 'not-found', minVersion: MIN_PI_VERSION })
    expect(await invoke('skills:list', '/workspace')).toEqual({ skills: [], probe: 'scan' })
    expect(h.skills.resolveSkills).toHaveBeenCalledWith({ workspacePath: '/workspace' })
    expect(h.env).not.toHaveBeenCalled()
  })

  it('propagates health, environment and scan errors', async () => {
    h.health.mockRejectedValueOnce(new Error('health failure'))
    await expect(invoke('skills:list')).rejects.toThrow('health failure')
    h.env.mockRejectedValueOnce(new Error('environment failure'))
    await expect(invoke('skills:list')).rejects.toThrow('environment failure')
    h.skills.resolveSkills.mockRejectedValueOnce(new Error('scan failure'))
    await expect(invoke('skills:list')).rejects.toThrow('scan failure')
  })

  it('reads a file without invalidation and propagates read errors', async () => {
    h.skills.readSkillFileEntry.mockResolvedValueOnce({ content: 'body' })
    expect(await invoke('skills:readFile', '/skill', 'SKILL.md')).toEqual({ content: 'body' })
    expect(h.skills.readSkillFileEntry).toHaveBeenCalledWith('/skill', 'SKILL.md')
    h.skills.readSkillFileEntry.mockRejectedValueOnce(new Error('unknown skill'))
    await expect(invoke('skills:readFile', '/skill', 'SKILL.md')).rejects.toThrow('unknown skill')
    expect(h.invalidate).not.toHaveBeenCalled()
  })

  it('restores bundled skills before invalidating and preserves restore errors', async () => {
    expect(await invoke('skills:restoreBundled')).toBeUndefined()
    expect(h.restore).toHaveBeenCalledWith(true)
    expect(h.restore.mock.invocationCallOrder[0]).toBeLessThan(
      h.invalidate.mock.invocationCallOrder[0]!,
    )
    h.invalidate.mockClear()
    h.restore.mockImplementationOnce(() => {
      throw new Error('restore failure')
    })
    await expect(invoke('skills:restoreBundled')).rejects.toThrow('restore failure')
    expect(h.invalidate).not.toHaveBeenCalled()
  })
})

const createOptions = {
  scope: 'user',
  name: 'demo',
  description: 'd',
  content: 'body',
  draft: false,
} as const
const importOptions = { sourcePath: '/import.zip', scope: 'user', overrideName: 'demo' } as const
const mutations = [
  {
    channel: 'skills:create',
    args: [createOptions],
    method: 'createSkill',
    forwarded: [createOptions],
  },
  {
    channel: 'skills:writeFile',
    args: ['/skill', 'SKILL.md', 'body', '/ws'],
    method: 'writeSkillFileEntry',
    forwarded: ['/skill', 'SKILL.md', 'body', '/ws'],
  },
  {
    channel: 'skills:delete',
    args: ['/skill', '/ws'],
    method: 'deleteSkill',
    forwarded: ['/skill', '/ws'],
  },
  {
    channel: 'skills:install',
    args: ['library', 'demo', { targetName: 'renamed', overwrite: true }],
    method: 'installCatalogSkill',
    forwarded: [
      { libraryId: 'library', skillName: 'demo', targetName: 'renamed', overwrite: true },
    ],
  },
  {
    channel: 'skills:importConfirm',
    args: [importOptions],
    method: 'confirmSkillImport',
    forwarded: [importOptions],
  },
] as const

describe('skills mutation characterization', () => {
  it.each(mutations)(
    '$channel forwards args and invalidates only after success',
    async ({ channel, args, method, forwarded }) => {
      const mutation = h.skills[method]
      let complete: (value: unknown) => void = () => {
        throw new Error('not started')
      }
      mutation.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve
          }),
      )
      const pending = invoke(channel, ...args)
      await Promise.resolve()
      expect(mutation).toHaveBeenCalledWith(...forwarded)
      expect(h.invalidate).not.toHaveBeenCalled()
      const result = { dir: '/result' }
      complete(result)
      expect(await pending).toBe(result)
      expect(h.invalidate).toHaveBeenCalledOnce()
      h.invalidate.mockClear()
      mutation.mockRejectedValueOnce(new Error('mutation refused'))
      await expect(invoke(channel, ...args)).rejects.toThrow('mutation refused')
      expect(h.invalidate).not.toHaveBeenCalled()
    },
  )

  it('installs with absent options', async () => {
    await invoke('skills:install', 'library', 'demo')
    expect(h.skills.installCatalogSkill).toHaveBeenCalledWith({
      libraryId: 'library',
      skillName: 'demo',
    })
  })
})

describe('skills archive dialog characterization', () => {
  it('prepares an export before the save dialog, then writes the selected path', async () => {
    expect(await invoke('skills:export', '/skill')).toEqual({ savedTo: '/saved.zip' })
    expect(h.skills.buildSkillZip).toHaveBeenCalledWith('/skill')
    expect(h.save).toHaveBeenCalledWith(h.window, {
      defaultPath: 'demo.zip',
      filters: [{ name: 'Skill bundle', extensions: ['zip', 'skill'] }],
    })
    expect(h.skills.buildSkillZip.mock.invocationCallOrder[0]).toBeLessThan(
      h.save.mock.invocationCallOrder[0]!,
    )
    expect(h.write).toHaveBeenCalledWith('/saved.zip', Buffer.from('zip'))
    expect(h.invalidate).not.toHaveBeenCalled()
  })

  it.each([{ canceled: true, filePath: '/ignored' }, { canceled: false }])(
    'does not write canceled or pathless exports: %j',
    async (result) => {
      h.save.mockResolvedValue(result)
      expect(await invoke('skills:export', '/skill')).toBeNull()
      expect(h.write).not.toHaveBeenCalled()
    },
  )

  it('previews the selected import without mutating or invalidating', async () => {
    const preview = { sourcePath: '/import.zip', name: 'demo' }
    h.skills.previewSkillImport.mockResolvedValue(preview)
    expect(await invoke('skills:importPick')).toBe(preview)
    expect(h.open).toHaveBeenCalledWith(h.window, {
      properties: ['openFile'],
      filters: [{ name: 'Skill', extensions: ['md', 'zip', 'skill'] }],
    })
    expect(h.skills.previewSkillImport).toHaveBeenCalledWith('/import.zip')
    expect(h.skills.confirmSkillImport).not.toHaveBeenCalled()
    expect(h.write).not.toHaveBeenCalled()
    expect(h.invalidate).not.toHaveBeenCalled()
  })

  it.each([
    { canceled: true, filePaths: ['/ignored'] },
    { canceled: false, filePaths: [] },
  ])('does not read or write canceled or empty import picks: %j', async (result) => {
    h.open.mockResolvedValue(result)
    expect(await invoke('skills:importPick')).toBeNull()
    expect(h.skills.previewSkillImport).not.toHaveBeenCalled()
    expect(h.write).not.toHaveBeenCalled()
  })

  it('propagates archive preparation, dialog and filesystem errors', async () => {
    h.skills.buildSkillZip.mockRejectedValueOnce(new Error('zip failure'))
    await expect(invoke('skills:export', '/skill')).rejects.toThrow('zip failure')
    expect(h.save).not.toHaveBeenCalled()
    h.save.mockRejectedValueOnce(new Error('save failure'))
    await expect(invoke('skills:export', '/skill')).rejects.toThrow('save failure')
    h.write.mockRejectedValueOnce(new Error('write failure'))
    await expect(invoke('skills:export', '/skill')).rejects.toThrow('write failure')
    h.open.mockRejectedValueOnce(new Error('open failure'))
    await expect(invoke('skills:importPick')).rejects.toThrow('open failure')
    h.skills.previewSkillImport.mockRejectedValueOnce(new Error('preview failure'))
    await expect(invoke('skills:importPick')).rejects.toThrow('preview failure')
  })
})
