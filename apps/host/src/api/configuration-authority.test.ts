import { expect, it } from 'vitest'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { createConfigurationAuthority } from './configuration-authority'

it('never revives admitted configuration calls or commands after loss and regrant', () => {
  let caps: readonly HostCapability[] = ['machine.configure', 'sessions.control']
  const authority = createConfigurationAuthority({
    caps: () => caps,
    closed: () => false,
    open: () => true,
  })
  const allowed = authority.admit('machine.configure')
  const sender = authority.sender({ id: 'client', label: 'Test' }, 'connection')
  expect(allowed()).toBe(true)
  expect(authority.renew(['sessions.control'])).toBe(true)
  caps = ['sessions.control']
  expect(allowed()).toBe(false)
  expect(authority.renew(['sessions.control', 'machine.configure'])).toBe(false)
  caps = ['sessions.control', 'machine.configure']
  expect(allowed()).toBe(false)
  expect(sender.currentCaps()).toEqual(['sessions.control'])
  expect(authority.admit('machine.configure')()).toBe(true)
  expect(authority.sender({ id: 'client', label: 'Test' }, 'new').currentCaps()).toEqual(caps)
})

it('checks current connection lifetime and capabilities for reads and configuration', () => {
  let closed = false
  let open = true
  const authority = createConfigurationAuthority({
    caps: () => ['machine.configure'],
    closed: () => closed,
    open: () => open,
  })
  const configured = authority.admit('machine.configure')
  const publicRead = authority.admit(null)
  expect(configured()).toBe(true)
  expect(authority.admit('sessions.control')()).toBe(false)
  open = false
  expect(configured()).toBe(false)
  expect(publicRead()).toBe(false)
  closed = true
  open = true
  expect(publicRead()).toBe(false)
  expect(authority.sender({ id: 'client', label: 'Test' }, 'connection').currentCaps()).toEqual([])
})
