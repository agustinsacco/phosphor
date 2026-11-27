import { describe, expect, it } from 'vitest'
import { findFolder, folderFilter, requireFolder } from './lane-folder'

const general = { id: '2195888e8680a316', name: 'general', path: '/home/bee3/src/general' }
const app = { id: 'aaaaaaaaaaaaaaaa', name: 'app', path: '/home/bee3/src/app' }
const otherApp = { id: 'bbbbbbbbbbbbbbbb', name: 'app', path: '/home/bee3/work/app' }

describe('findFolder', () => {
  it('matches an ID, a path, or a unique name', () => {
    expect(findFolder([general], general.id)).toBe(general)
    expect(findFolder([general], general.path)).toBe(general)
    expect(findFolder([general], 'general')).toBe(general)
    expect(findFolder([general], 'missing')).toBeUndefined()
  })

  it('reports a shared name as ambiguous, but an ID or path still wins', () => {
    expect(findFolder([app, otherApp], 'app')).toBe('ambiguous')
    expect(findFolder([app, otherApp], otherApp.path)).toBe(otherApp)
    const named = { ...general, name: app.id }
    expect(findFolder([named, app], app.id)).toBe(app)
  })
})

describe('requireFolder', () => {
  it('names the registered folders when nothing matches', () => {
    expect(() => requireFolder([general], 'genral')).toThrow(
      'No registered folder matches genral. Pass a folder name, path or ID. Registered folders: general (/home/bee3/src/general).',
    )
    expect(() => requireFolder([], 'x')).toThrow('No folders are registered on this machine.')
  })

  it('lists only the clashing folders for an ambiguous name', () => {
    expect(() => requireFolder([general, app, otherApp], 'app')).toThrow(
      'More than one registered folder is named app; pass its path or ID. Registered folders: app (/home/bee3/src/app), app (/home/bee3/work/app).',
    )
  })

  it('caps a long list', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `${i}`,
      name: `f${i}`,
      path: `/f${i}`,
    }))
    expect(() => requireFolder(many, 'nope')).toThrow(/f9 \(\/f9\), and 2 more\.$/)
  })
})

describe('folderFilter', () => {
  it('turns a folder name into its ID and leaves unknown values alone', () => {
    expect(folderFilter([general], { folder: 'general', q: 'x' })).toEqual({
      folder: general.id,
      q: 'x',
    })
    expect(folderFilter([general], { folder: 'missing' })).toEqual({ folder: 'missing' })
    expect(folderFilter([app, otherApp], { folder: 'app' })).toEqual({ folder: 'app' })
    expect(folderFilter([general], {})).toEqual({})
  })
})
