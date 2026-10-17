import { expect, it } from 'vitest'
import { ipRateKey } from './ip-rate-key'

it('collides every compressed, expanded and upper-case spelling inside one IPv6 /64', () => {
  for (const address of [
    '2001:db8:1:2::1',
    '2001:db8:1:2::',
    '2001:DB8:1:2:FFFF:FFFF:FFFF:FFFF',
    '2001:0db8:0001:0002:0000:0000:0000:0001',
    '2001:db8:1:2:a:b:c:d',
    '2001:db8:1:2:0:0:1.2.3.4',
    '2001:db8:1:2::1%eth0',
  ])
    expect(ipRateKey(address)).toBe('2001:db8:1:2::/64')
  expect(ipRateKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
  expect(ipRateKey('2001:db8::1:2:3:4')).toBe('2001:db8:0:0::/64')
  expect(ipRateKey('::')).toBe('0:0:0:0::/64')
  expect(ipRateKey('::1')).toBe('0:0:0:0::/64')
  expect(ipRateKey('fe80::1%en0')).toBe('fe80:0:0:0::/64')
})

it('gives distinct /64 networks distinct keys', () => {
  const keys = [
    '2001:db8:1:2::1',
    '2001:db8:1:3::1',
    '2001:db8:2:2::1',
    '2001:db9:1:2::1',
    '2002:db8:1:2::1',
    '2001:db8:1:2:1::',
  ].map(ipRateKey)
  expect(new Set(keys).size).toBe(5)
  expect(keys[0]).toBe(keys[5])
})

it('keys IPv4-mapped IPv6 as its IPv4 address and leaves IPv4 unchanged', () => {
  for (const address of [
    '::ffff:192.0.2.1',
    '::FFFF:192.0.2.1',
    '::ffff:c000:201',
    '0:0:0:0:0:ffff:c000:0201',
    '0000:0000:0000:0000:0000:ffff:192.0.2.1',
  ])
    expect(ipRateKey(address)).toBe('192.0.2.1')
  expect(ipRateKey('192.0.2.1')).toBe('192.0.2.1')
  expect(ipRateKey('10.42.0.1')).toBe('10.42.0.1')
  expect(ipRateKey('::ffff:0.0.0.0')).toBe('0.0.0.0')
  // Neither the IPv4-compatible nor the NAT64 prefix is the mapped one.
  expect(ipRateKey('::192.0.2.1')).toBe('0:0:0:0::/64')
  expect(ipRateKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64')
  expect(ipRateKey('::fffe:192.0.2.1')).toBe('0:0:0:0::/64')
})

it('maps anything that is not an IP address to one deterministic fallback', () => {
  for (const address of [
    'unknown',
    '',
    'invalid',
    '01.2.3.4',
    '192.0.2.1, 192.0.2.2',
    '2001:db8::1::2',
    '2001:db8:1:2:3:4:5:6:7',
    '[2001:db8::1]',
    '2001:db8::/64',
  ])
    expect(ipRateKey(address)).toBe('unknown')
})
