import { describe, expect, it } from 'vitest'
import { classifyMachine, type MachineFacts } from '../src/main/machine-profile'
import { cleanFact, pcIdentity, vendorName } from '../src/main/machine-names'
import type { MachineKind } from '../src/shared/fleet'
import { assertProfile } from './fleet-shape'

// What a desktop figure's caption gets (Gouache's forms): the scene
// passes profile.label, else profile.model. Every fact here is a public model
// string or invented; none is a serial, a UUID or a host name.

const base = (extra: Partial<MachineFacts>): MachineFacts => ({
  platform: 'linux',
  arch: 'x64',
  kernel: '6.8.0-45-generic',
  osVersion: 'Ubuntu 24.04.1 LTS',
  cpus: 16,
  memoryBytes: 64 * 2 ** 30,
  envNames: [],
  containerEnv: null,
  ...extra
})

const mac = (hwModel: string, battery: boolean): MachineFacts =>
  base({ platform: 'darwin', arch: 'arm64', kernel: '25.5.0', osVersion: 'macOS 26.5', mac: { hwModel, battery, hvVmmPresent: false } })

const linux = (dmi: Partial<NonNullable<MachineFacts['linux']>>, extra: Partial<MachineFacts> = {}): MachineFacts =>
  base({
    linux: {
      sysVendor: null,
      productName: null,
      chassisType: null,
      cgroup: '0::/init.scope',
      dockerEnv: false,
      containerEnvFile: false,
      hypervisorFlag: false,
      battery: false,
      ...dmi
    },
    ...extra
  })

type Want = [name: string, facts: MachineFacts, kind: MachineKind, label: string, model: string | null]

const CASES: Want[] = [
  ['this Mac (MacBook Pro 16-inch 2021)', mac('MacBookPro18,1', true), 'laptop', 'MacBook Pro 16-inch (2021)', 'MacBookPro18,1'],
  ['a Mac Studio (2023)', mac('Mac14,13', false), 'desktop', 'Mac Studio (2023)', 'Mac14,13'],
  ['a Mac Studio (2025)', mac('Mac16,9', false), 'desktop', 'Mac Studio (2025)', 'Mac16,9'],
  ['a Mac Pro (2023)', mac('Mac14,8', false), 'desktop', 'Mac Pro (2023)', 'Mac14,8'],
  ['a Mac Pro (2019)', mac('MacPro7,1', false), 'desktop', 'Mac Pro (2019)', 'MacPro7,1'],
  ['an iMac (2024)', mac('Mac16,3', false), 'desktop', 'iMac 24-inch (2024)', 'Mac16,3'],
  ['an iMac (2020)', mac('iMac20,1', false), 'desktop', 'iMac 27-inch (2020)', 'iMac20,1'],
  ['a Mac mini (2024)', mac('Mac16,11', false), 'desktop', 'Mac mini (2024)', 'Mac16,11'],
  ['a Mac mini of an unknown year', mac('Macmini99,1', false), 'desktop', 'Mac mini', 'Macmini99,1'],
  [
    'a Linux PC from a maker',
    linux({ sysVendor: 'Dell Inc.', productName: 'OptiPlex 7010', chassisType: 3 }),
    'desktop',
    'Dell OptiPlex 7010',
    'OptiPlex 7010'
  ],
  [
    'a self-built Linux PC, named by its board',
    linux({ sysVendor: 'To Be Filled By O.E.M.', productName: 'To Be Filled By O.E.M.', boardVendor: 'ASUSTeK COMPUTER INC.', boardName: 'ROG STRIX B550-F GAMING', chassisType: 3 }),
    'desktop',
    'ASUS ROG STRIX B550-F GAMING',
    'ROG STRIX B550-F GAMING'
  ],
  [
    'a ThinkPad, named from product_version',
    linux({ sysVendor: 'LENOVO', productName: '21HM', productVersion: 'ThinkPad X1 Carbon Gen 11', chassisType: 10 }),
    'laptop',
    'Lenovo ThinkPad X1 Carbon Gen 11',
    '21HM'
  ],
  ['a Raspberry Pi, named by its device tree', linux({ deviceTreeModel: 'Raspberry Pi 5 Model B Rev 1.0\u0000' }), 'unknown', 'Raspberry Pi 5 Model B Rev 1.0', 'Raspberry Pi 5 Model B Rev 1.0'],
  ['an EC2 instance', linux({ sysVendor: 'Amazon EC2', productName: 'c7g.2xlarge', chassisType: 1 }), 'cloud', 'AWS EC2', 'c7g.2xlarge'],
  ['a GCE instance, no machine type in firmware', linux({ sysVendor: 'Google', productName: 'Google Compute Engine' }), 'cloud', 'Google Compute Engine', null],
  ['an Azure VM, by its fixed asset tag', linux({ sysVendor: 'Microsoft Corporation', productName: 'Virtual Machine', azure: true }), 'cloud', 'Azure VM', null],
  ['a DigitalOcean droplet', linux({ sysVendor: 'DigitalOcean', productName: 'Droplet' }), 'cloud', 'DigitalOcean Droplet', 'Droplet'],
  ['a Docker container', linux({ dockerEnv: true }), 'sandbox', 'Docker container', null],
  ['an E2B sandbox', linux({}, { envNames: ['E2B_SANDBOX_ID'] }), 'sandbox', 'E2B sandbox', null]
]

describe('what a figure’s caption is drawn from', () => {
  for (const [name, facts, kind, label, model] of CASES) {
    it(`names ${name}`, () => {
      const profile = classifyMachine(facts)
      assertProfile(profile)
      expect({ kind: profile.kind, label: profile.label, model: profile.model }).toEqual({ kind, label, model })
      // The scene's caption, label else model, is never empty for hardware we can name.
      expect(profile.label ?? profile.model).toBeTruthy()
    })
  }
})

describe('firmware strings to friendly names', () => {
  it('drops placeholders', () => {
    for (const raw of ['To Be Filled By O.E.M.', 'System Product Name', 'Default string', 'Not Applicable', '  ', 'None']) expect(cleanFact(raw)).toBeNull()
    expect(cleanFact(' OptiPlex 7010 ')).toBe('OptiPlex 7010')
  })

  it('names vendors the way people do', () => {
    expect(vendorName('Micro-Star International Co., Ltd.')).toBe('MSI')
    expect(vendorName('ASUSTeK COMPUTER INC.')).toBe('ASUS')
    expect(vendorName('Hewlett-Packard')).toBe('HP')
    expect(vendorName('Hewlett Packard Enterprise')).toBe('HPE')
    expect(vendorName('Foo Systems, Inc.')).toBe('Foo Systems')
    expect(vendorName('System manufacturer')).toBeNull()
  })

  it('does not repeat a vendor its product already names', () => {
    expect(pcIdentity({ vendor: 'Framework', product: 'Laptop 13 (AMD Ryzen 7040Series)' }).label).toBe('Framework Laptop 13 (AMD Ryzen 7040Series)')
    expect(pcIdentity({ vendor: 'Dell Inc.', product: 'Dell G15 5530' }).label).toBe('Dell G15 5530')
  })

  it('keeps a serial-shaped model out of the profile', () => {
    const profile = classifyMachine(linux({ sysVendor: 'LENOVO', productName: '21HMCTO1WW', productVersion: 'ThinkPad X1 Carbon Gen 11', chassisType: 10 }))
    expect(profile.label).toBe('Lenovo ThinkPad X1 Carbon Gen 11')
    expect(profile.model).toBeNull()
  })
})
