import { expect, it } from 'vitest'
import { editedFilesNote, recoveryOptions } from './worktreeRecovery'

const none = { editedFiles: [], editedFileCount: 0 }

it('orders options from most exact to a fresh start', () => {
  const options = recoveryOptions({
    ...none,
    saved: { tip: 'abcdef0123456789', branch: 'phosphor/lane' },
    branch: { name: 'agustin/lane', tip: '0123456789abcdef', subject: 'Fix it', remoteOnly: true },
    fresh: { base: 'origin/main', branch: 'phosphor/lane-2' },
  })
  expect(options.map((o) => o.value)).toEqual(['saved', 'branch', 'fresh'])
  expect(options.map((o) => o.label)).toEqual([
    'Restore saved commit abcdef01',
    'Check out agustin/lane',
    'New branch from origin/main',
  ])
  expect(options[1]?.detail).toBe('On origin only. Latest commit 01234567: Fix it')
  expect(options[2]?.detail).toContain('phosphor/lane-2')
})

it('offers nothing when main found nothing', () => {
  expect(recoveryOptions({ ...none, unavailable: 'Repository missing.' })).toEqual([])
})

it('says plainly whether earlier edits are lost', () => {
  expect(editedFilesNote(none)).toContain('did not edit or write files')
  expect(editedFilesNote({ editedFiles: ['a.ts'], editedFileCount: 1 })).toContain('1 file in')
  expect(editedFilesNote({ editedFiles: ['a.ts', 'b.ts'], editedFileCount: 5 })).toContain(
    'a.ts, b.ts, and 3 more',
  )
})
