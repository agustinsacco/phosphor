import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as InvokerModule from './invoker'
import { PiUnavailableError, type PiInvocationProfile, type ResolvedPiInvoker } from './invoker'
import {
  confirmSkillImportAction,
  createSkillAction,
  deleteSkillAction,
  exportSkill,
  installSkillAction,
  listSkills,
  pickSkillImport,
  restoreBundledSkill,
  writeSkillFileAction,
} from './skill-actions'

const h = vi.hoisted(() => ({
  invoker: vi.fn<(profile: PiInvocationProfile) => Promise<ResolvedPiInvoker>>(),
  invalidate: vi.fn(),
  restore: vi.fn(),
  write: vi.fn(),
  skills: {
    resolveSkills: vi.fn(),
    createSkill: vi.fn(),
    writeSkillFileEntry: vi.fn(),
    deleteSkill: vi.fn(),
    installCatalogSkill: vi.fn(),
    confirmSkillImport: vi.fn(),
    buildSkillZip: vi.fn(),
    previewSkillImport: vi.fn(),
  },
}))
vi.mock('./invoker', async (importOriginal) => ({
  ...(await importOriginal<typeof InvokerModule>()),
  resolvePiInvoker: h.invoker,
}))
vi.mock('./catalogue', () => ({ invalidatePiCommands: h.invalidate }))
vi.mock('./session-launch', () => ({ ensureDesktopArtifactSkill: h.restore }))
vi.mock('./skills', () => h.skills)
vi.mock('node:fs/promises', () => ({ writeFile: h.write }))

beforeEach(() => {
  vi.resetAllMocks()
  h.invoker.mockResolvedValue({
    binaryPath: '/pi',
    prefixArgs: [],
    env: { PATH: '/shell' },
    stub: false,
  })
})

describe('listSkills', () => {
  it('selects the shared minimal-stub invoker and forwards only probe options', async () => {
    h.invoker.mockResolvedValue({
      binaryPath: process.execPath,
      prefixArgs: ['/stub.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      stub: true,
    })
    const result = { skills: [], probe: 'scan' }
    h.skills.resolveSkills.mockResolvedValue(result)
    expect(await listSkills('/ws')).toBe(result)
    expect(h.invoker).toHaveBeenCalledExactlyOnceWith('minimal-stub')
    expect(h.skills.resolveSkills).toHaveBeenCalledExactlyOnceWith({
      workspacePath: '/ws',
      binaryPath: process.execPath,
      prefixArgs: ['/stub.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('forwards real-pi prefix arguments and environment', async () => {
    h.invoker.mockResolvedValue({
      binaryPath: '/node',
      prefixArgs: ['/pi.js'],
      env: { TOKEN: 'current' },
      stub: false,
    })
    await listSkills()
    expect(h.skills.resolveSkills).toHaveBeenCalledWith({
      binaryPath: '/node',
      prefixArgs: ['/pi.js'],
      env: { TOKEN: 'current' },
    })
  })

  it.each([undefined, '/ws'])(
    'scans on unavailable pi with workspace %s',
    async (workspacePath) => {
      h.invoker.mockRejectedValue(new PiUnavailableError('missing'))
      await listSkills(workspacePath)
      expect(h.skills.resolveSkills).toHaveBeenCalledWith(workspacePath ? { workspacePath } : {})
    },
  )

  it('does not turn environment or discovery errors into scan fallbacks', async () => {
    const error = new Error('environment unavailable')
    h.invoker.mockRejectedValue(error)
    await expect(listSkills()).rejects.toBe(error)
    expect(h.skills.resolveSkills).not.toHaveBeenCalled()
  })
})

const createOptions = {
  scope: 'user',
  name: 'demo',
  description: 'd',
  content: '',
  draft: false,
} as const
const importOptions = { sourcePath: '/source.md', scope: 'user' } as const
const mutations = [
  {
    name: 'createSkillAction',
    run: () => createSkillAction(createOptions),
    method: 'createSkill',
    args: [createOptions],
  },
  {
    name: 'writeSkillFileAction',
    run: () => writeSkillFileAction('/dir', 'SKILL.md', 'body', '/ws'),
    method: 'writeSkillFileEntry',
    args: ['/dir', 'SKILL.md', 'body', '/ws'],
  },
  {
    name: 'deleteSkillAction',
    run: () => deleteSkillAction('/dir', '/ws'),
    method: 'deleteSkill',
    args: ['/dir', '/ws'],
  },
  {
    name: 'installSkillAction',
    run: () => installSkillAction('library', 'demo', { targetName: 'renamed', overwrite: true }),
    method: 'installCatalogSkill',
    args: [{ libraryId: 'library', skillName: 'demo', targetName: 'renamed', overwrite: true }],
  },
  {
    name: 'confirmSkillImportAction',
    run: () => confirmSkillImportAction(importOptions),
    method: 'confirmSkillImport',
    args: [importOptions],
  },
] as const

describe('skill mutation actions', () => {
  it.each(mutations)(
    '$name waits for success before invalidating',
    async ({ run, method, args }) => {
      let complete: (value: unknown) => void = () => {
        throw new Error('not started')
      }
      h.skills[method].mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve
          }),
      )
      const pending = run()
      expect(h.skills[method]).toHaveBeenCalledWith(...args)
      expect(h.invalidate).not.toHaveBeenCalled()
      const result = { dir: '/result' }
      complete(result)
      expect(await pending).toBe(result)
      expect(h.invalidate).toHaveBeenCalledOnce()
    },
  )

  it.each(mutations)('$name preserves failures without invalidating', async ({ run, method }) => {
    const error = new Error('refused')
    h.skills[method].mockRejectedValueOnce(error)
    await expect(run()).rejects.toBe(error)
    expect(h.invalidate).not.toHaveBeenCalled()
  })

  it('restores bundled skills synchronously before invalidating', () => {
    expect(restoreBundledSkill()).toBeUndefined()
    expect(h.restore).toHaveBeenCalledExactlyOnceWith(true)
    expect(h.restore.mock.invocationCallOrder[0]).toBeLessThan(
      h.invalidate.mock.invocationCallOrder[0]!,
    )
    h.invalidate.mockClear()
    h.restore.mockImplementationOnce(() => {
      throw new Error('restore failed')
    })
    expect(restoreBundledSkill).toThrow('restore failed')
    expect(h.invalidate).not.toHaveBeenCalled()
  })
})

describe('skill archive actions', () => {
  it('prepares an archive before choosing a path and waits for its write', async () => {
    const data = Buffer.from('archive')
    h.skills.buildSkillZip.mockResolvedValue({ fileName: 'demo.zip', data })
    const choose = vi.fn(async () => '/destination.zip')
    let finish: () => void = () => {
      throw new Error('not writing')
    }
    h.write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    let settled = false
    const pending = exportSkill('/dir', choose).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(h.write).toHaveBeenCalledWith('/destination.zip', data))
    expect(choose).toHaveBeenCalledExactlyOnceWith('demo.zip')
    expect(h.skills.buildSkillZip).toHaveBeenCalledExactlyOnceWith('/dir')
    expect(h.skills.buildSkillZip.mock.invocationCallOrder[0]).toBeLessThan(
      choose.mock.invocationCallOrder[0]!,
    )
    expect(settled).toBe(false)
    finish()
    expect(await pending).toEqual({ savedTo: '/destination.zip' })
    expect(h.invalidate).not.toHaveBeenCalled()
  })

  it('does not write a canceled export', async () => {
    h.skills.buildSkillZip.mockResolvedValue({ fileName: 'demo.zip', data: Buffer.from('zip') })
    expect(await exportSkill('/dir', async () => null)).toBeNull()
    expect(h.write).not.toHaveBeenCalled()
  })

  it('does not open a destination picker when archive preparation fails', async () => {
    h.skills.buildSkillZip.mockRejectedValue(new Error('unreadable'))
    const choose = vi.fn(async () => '/destination.zip')
    await expect(exportSkill('/dir', choose)).rejects.toThrow('unreadable')
    expect(choose).not.toHaveBeenCalled()
    expect(h.write).not.toHaveBeenCalled()
  })

  it('previews only a selected source, without writing or invalidating', async () => {
    const preview = { name: 'demo' }
    h.skills.previewSkillImport.mockResolvedValue(preview)
    expect(await pickSkillImport(async () => '/source.md')).toBe(preview)
    expect(h.skills.previewSkillImport).toHaveBeenCalledExactlyOnceWith('/source.md')
    h.skills.previewSkillImport.mockClear()
    expect(await pickSkillImport(async () => null)).toBeNull()
    expect(h.skills.previewSkillImport).not.toHaveBeenCalled()
    expect(h.write).not.toHaveBeenCalled()
    expect(h.invalidate).not.toHaveBeenCalled()
  })
})
