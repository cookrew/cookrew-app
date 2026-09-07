import { describe, expect, it } from 'vitest'
import {
  interfaceKind,
  isSubnetAddress,
  publishedAddresses,
  publishesEveryInterface,
  realInterfaces,
  type LocalInterface
} from '../src/shared/interface-kind'
import { isTailnetAddress } from '../src/main/tailscale'

const RULES = { isTailnet: isTailnetAddress }

/**
 * THE INCIDENT, AS THE OS REPORTED IT — five addresses, four bridges,
 * measured from a phone's path report on 2026-09-08.
 *
 * One of these is the Wi-Fi. The other four are host-only networks a container
 * runtime and a VM host brought up, and three of those are not even host
 * addresses — they are the subnet's own address, ending in .0.
 */
const FIVE: LocalInterface[] = [
  { name: 'en0', address: '192.168.2.40', netmask: '255.255.255.0' },
  { name: 'bridge100', address: '192.168.139.3', netmask: '255.255.255.0' },
  { name: 'bridge101', address: '192.168.215.0', netmask: '255.255.255.0' },
  { name: 'bridge102', address: '192.168.164.0', netmask: '255.255.255.0' },
  { name: 'bridge103', address: '192.168.156.0', netmask: '255.255.255.0' }
]

/** Tailscale's utun, exactly as macOS reports it: a /32 on a virtual name. */
const TAILNET_UTUN: LocalInterface = {
  name: 'utun4',
  address: '100.101.102.103',
  netmask: '255.255.255.255'
}

describe('the five-interface Mac', () => {
  it('publishes ONE address — the Wi-Fi, not the four bridges', () => {
    expect(publishedAddresses(FIVE, RULES)).toEqual(['192.168.2.40'])
  })

  it('calls every bridge virtual and only en0 real', () => {
    const kinds = FIVE.map((iface) => `${iface.name}=${interfaceKind(iface, RULES)}`)
    expect(kinds).toEqual([
      'en0=real',
      'bridge100=virtual',
      'bridge101=virtual',
      'bridge102=virtual',
      'bridge103=virtual'
    ])
  })
})

describe('the name rule', () => {
  it('refuses the virtual families a developer Mac grows', () => {
    const virtual = [
      'bridge100',
      'vmnet8',
      'vboxnet0',
      'utun6',
      'awdl0',
      'llw0',
      'gif0',
      'stf0',
      'ap1',
      'p2p0',
      'anpi0',
      'docker0',
      'veth1a2b3c',
      'virbr0',
      'lxcbr0'
    ]
    for (const name of virtual) {
      expect(interfaceKind({ name, address: '10.1.2.3' }, RULES)).toBe('virtual')
    }
  })

  it('keeps the interfaces a phone can actually reach', () => {
    for (const name of ['en0', 'en1', 'eth0', 'wlan0']) {
      expect(interfaceKind({ name, address: '10.1.2.3' }, RULES)).toBe('real')
    }
  })
})

describe('the tailnet exception', () => {
  it('keeps a utun that carries the Tailscale address', () => {
    // `utun` is on the virtual list and the mask is a /32, so BOTH rules would
    // drop it. The tailnet path is the one that works off this Wi-Fi.
    expect(interfaceKind(TAILNET_UTUN, RULES)).toBe('real')
    expect(publishedAddresses([...FIVE, TAILNET_UTUN], RULES)).toEqual([
      '192.168.2.40',
      '100.101.102.103'
    ])
  })

  it('still refuses a utun carrying anything else', () => {
    const vpn: LocalInterface = { name: 'utun3', address: '10.8.0.6', netmask: '255.255.255.0' }
    expect(interfaceKind(vpn, RULES)).toBe('virtual')
  })

  it('uses the same 100.64/10 boundary as tailscale.ts, not a bare `100.`', () => {
    const near: LocalInterface = { name: 'utun3', address: '100.5.4.3', netmask: '255.255.255.0' }
    expect(interfaceKind(near, RULES)).toBe('virtual')
  })
})

describe('the subnet-address rule', () => {
  it('refuses a /24 host part of 0 even on a real interface name', () => {
    const bad: LocalInterface = { name: 'en5', address: '192.168.215.0', netmask: '255.255.255.0' }
    expect(interfaceKind(bad, RULES)).toBe('virtual')
    expect(isSubnetAddress('192.168.215.0', '255.255.255.0')).toBe(true)
  })

  it('assumes /24 when the OS reported no mask', () => {
    expect(isSubnetAddress('192.168.215.0')).toBe(true)
    expect(isSubnetAddress('192.168.215.4')).toBe(false)
  })

  it('reads the interface’s OWN mask when it has one', () => {
    // 10.4.0.0 is a legal host on a /8 and the subnet address on a /16.
    expect(isSubnetAddress('10.4.0.0', '255.0.0.0')).toBe(false)
    expect(isSubnetAddress('10.4.0.0', '255.255.0.0')).toBe(true)
  })

  it('leaves a /32 alone — a point-to-point link has no host part to be zero', () => {
    expect(isSubnetAddress('10.8.0.0', '255.255.255.255')).toBe(false)
  })

  it('says nothing about IPv6, which has no dotted-quad host part', () => {
    expect(isSubnetAddress('fd7a:115c:a1e0::1234')).toBe(false)
  })
})

describe('order — the first probe should be the one most likely to answer', () => {
  it('puts en* ahead of every other real interface', () => {
    const mixed: LocalInterface[] = [
      { name: 'ppp0', address: '10.9.9.9', netmask: '255.255.255.0' },
      { name: 'en0', address: '192.168.2.40', netmask: '255.255.255.0' },
      { name: 'en1', address: '192.168.2.41', netmask: '255.255.255.0' }
    ]
    expect(publishedAddresses(mixed, RULES)).toEqual([
      '192.168.2.40',
      '192.168.2.41',
      '10.9.9.9'
    ])
  })

  it('keeps the OS order within each group and lists an address once', () => {
    const doubled: LocalInterface[] = [
      { name: 'en1', address: '192.168.2.41', netmask: '255.255.255.0' },
      { name: 'en0', address: '192.168.2.40', netmask: '255.255.255.0' },
      { name: 'en0', address: '192.168.2.40', netmask: '255.255.255.0' }
    ]
    expect(publishedAddresses(doubled, RULES)).toEqual(['192.168.2.41', '192.168.2.40'])
  })
})

describe('the escape hatch', () => {
  const ALL = { COOKREW_PUBLISH_INTERFACES: 'all' }

  it('publishes everything, in the same en-first order, for a bridge-only Mac', () => {
    expect(publishedAddresses(FIVE, { ...RULES, env: ALL })).toEqual([
      '192.168.2.40',
      '192.168.139.3',
      '192.168.215.0',
      '192.168.164.0',
      '192.168.156.0'
    ])
  })

  it('is off for every other value, including unset', () => {
    expect(publishesEveryInterface({})).toBe(false)
    expect(publishesEveryInterface({ COOKREW_PUBLISH_INTERFACES: '' })).toBe(false)
    expect(publishesEveryInterface({ COOKREW_PUBLISH_INTERFACES: '1' })).toBe(false)
    expect(publishesEveryInterface({ COOKREW_PUBLISH_INTERFACES: ' ALL ' })).toBe(true)
  })

  it('does not change the classification, only what is published', () => {
    // The hatch is a publishing override, not a claim that a bridge is real.
    expect(interfaceKind(FIVE[1], { ...RULES, env: ALL })).toBe('virtual')
    expect(realInterfaces(FIVE, { ...RULES, env: ALL })).toHaveLength(5)
  })
})
