import { expect, it, vi } from 'vitest'
import { adoptLegacyUserData } from './adopt-user-data'
const fixture = (paths: string[]) => ({
  userData: () => '/profile/Phosphor',
  exists: vi.fn((path: string) => paths.includes(path)),
  rename: vi.fn(),
})
it('never probes either installed profile when an unpackaged test redirects userData', () => {
  const f = fixture(['/profile/pidex'])
  adoptLegacyUserData({ ...f, isPackaged: false, testUserData: '/scratch' })
  expect(f.exists).not.toHaveBeenCalled()
  expect(f.rename).not.toHaveBeenCalled()
})
it.each([true, false])('adopts an existing legacy profile, packaged=%s', (isPackaged) => {
  const f = fixture(['/profile/pidex'])
  adoptLegacyUserData({ ...f, isPackaged, testUserData: isPackaged ? '/ignored' : undefined })
  expect(f.rename).toHaveBeenCalledExactlyOnceWith('/profile/pidex', '/profile/Phosphor')
})
it.each([[], ['/profile/pidex', '/profile/Phosphor']])(
  'leaves a fresh or current profile alone',
  (...paths) => {
    const f = fixture(paths)
    adoptLegacyUserData({ ...f, isPackaged: true })
    expect(f.rename).not.toHaveBeenCalled()
  },
)
