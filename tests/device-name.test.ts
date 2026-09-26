// WHAT A MAC CALLS ITSELF ON THE ACCOUNT (v3, D12): "<model> · <host>", and a
// counter only when even that collides. The decision is client-side and pure —
// the registry files whatever it is sent — so this is where it is pinned.

import { describe, expect, it } from 'vitest'
import { deviceDisplayName, hostLabel, modelLabel } from '../src/shared/device-name'

describe('the model, as a person says it', () => {
  it('maps the identifiers Apple emits to the family name', () => {
    expect(modelLabel('MacBookPro18,3')).toBe('MacBook Pro')
    expect(modelLabel('MacBookAir10,1')).toBe('MacBook Air')
    expect(modelLabel('MacBook10,1')).toBe('MacBook')
    expect(modelLabel('Macmini9,1')).toBe('Mac mini')
    expect(modelLabel('MacStudio1,2')).toBe('Mac Studio')
    expect(modelLabel('MacPro7,1')).toBe('Mac Pro')
    expect(modelLabel('iMacPro1,1')).toBe('iMac Pro')
    expect(modelLabel('iMac21,1')).toBe('iMac')
    // Apple silicon from 2022 on: the family is gone from the identifier.
    expect(modelLabel('Mac14,7')).toBe('Mac')
  })

  it('keeps an identifier it does not know, and calls nothing "" ', () => {
    expect(modelLabel('VirtualMac2,1')).toBe('VirtualMac2,1')
    expect(modelLabel('')).toBe('Mac')
    expect(modelLabel('   ')).toBe('Mac')
  })
})

describe('the host, as a person set it', () => {
  it('drops the mDNS suffix and nothing else', () => {
    expect(hostLabel('drej-mbp.local')).toBe('drej-mbp')
    expect(hostLabel('TenonWorkspace-4602.LOCAL')).toBe('TenonWorkspace-4602')
    expect(hostLabel('studio')).toBe('studio')
  })

  it('is still a name when the hostname is empty', () => {
    expect(hostLabel('')).toBe('this-mac')
  })
})

describe('the name on the account', () => {
  it('is "<model> · <host>"', () => {
    expect(deviceDisplayName({ model: 'MacBookPro18,3', host: 'drej-mbp.local', taken: [] })).toBe(
      'MacBook Pro · drej-mbp',
    )
  })

  it('tells two Macs of the same model apart by host, with no counter', () => {
    const first = deviceDisplayName({ model: 'MacBookPro18,3', host: 'drej-mbp.local', taken: [] })
    const second = deviceDisplayName({ model: 'MacBookPro18,3', host: 'studio.local', taken: [first] })
    expect(first).not.toBe(second)
    expect(second).toBe('MacBook Pro · studio')
  })

  it('adds " (2)" only when the whole name is already on the account', () => {
    const taken = ['MacBook Pro · drej-mbp', 'Mac Studio · studio']
    expect(deviceDisplayName({ model: 'MacBookPro18,3', host: 'drej-mbp', taken })).toBe(
      'MacBook Pro · drej-mbp (2)',
    )
    // The prefix alone is not a collision.
    expect(deviceDisplayName({ model: 'MacBookPro18,3', host: 'drej-mbp-2', taken })).toBe(
      'MacBook Pro · drej-mbp-2',
    )
  })

  it('climbs past a taken counter rather than stopping at 2', () => {
    const taken = ['MacBook Pro · drej-mbp', 'MacBook Pro · drej-mbp (2)', 'MacBook Pro · drej-mbp (3)']
    expect(deviceDisplayName({ model: 'MacBookPro18,3', host: 'drej-mbp', taken })).toBe(
      'MacBook Pro · drej-mbp (4)',
    )
  })

  it('ignores surrounding whitespace in the names the registry lists', () => {
    expect(deviceDisplayName({ model: 'MacBookPro18,3', host: 'drej-mbp', taken: ['  MacBook Pro · drej-mbp '] })).toBe(
      'MacBook Pro · drej-mbp (2)',
    )
  })
})
