import { describe, expect, it } from 'vitest'
import { classifyMachine, macModel, safeFact, type MachineFacts } from '../src/main/machine-profile'
import type { MachineKind } from '../src/shared/levels'
import { assertProfile } from './levels-shape'

// Fixture facts per kind. Every value is invented or a public model string;
// none is a serial, a UUID, a MAC address or a host name.

const base = (extra: Partial<MachineFacts>): MachineFacts => ({
  platform: 'linux',
  arch: 'x64',
  kernel: '6.8.0-45-generic',
  osVersion: 'Ubuntu 24.04.1 LTS',
  cpus: 8,
  memoryBytes: 16 * 2 ** 30,
  envNames: [],
  containerEnv: null,
  ...extra
})

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

const mac = (hwModel: string | null, battery: boolean | null, hvVmmPresent: boolean | null = false): MachineFacts =>
  base({ platform: 'darwin', arch: 'arm64', kernel: '25.5.0', osVersion: 'macOS 26.5', mac: { hwModel, battery, hvVmmPresent } })

const windows = (w: Partial<NonNullable<MachineFacts['windows']>>): MachineFacts =>
  base({
    platform: 'win32',
    kernel: '10.0.26100',
    osVersion: 'Windows 10.0.26100',
    windows: { manufacturer: null, model: null, pcSystemType: null, chassisTypes: [], ...w }
  })

const CASES: Array<[name: string, facts: MachineFacts, kind: MachineKind, label: string | null, evidence: string]> = [
  ['a MacBook Pro by model and battery', mac('MacBookPro18,1', true), 'laptop', 'MacBook Pro 16-inch (2021)', 'battery=present'],
  ['a Mac mini by model and no battery', mac('Mac14,12', false), 'desktop', 'Mac mini (2023)', 'battery=absent'],
  ['a new Apple id decided by the battery', mac('Mac17,9', true), 'laptop', 'Mac', 'hw.model=Mac17,9'],
  ['a macOS VM by kern.hv_vmm_present', mac('Mac14,3', false, true), 'vm', 'macOS virtual machine', 'kern.hv_vmm_present=1'],
  ['a Linux laptop by chassis', linux({ sysVendor: 'LENOVO', productName: 'ThinkPad X1 Carbon Gen 11', chassisType: 10 }), 'laptop', 'Lenovo ThinkPad X1 Carbon Gen 11', 'dmi.chassis_type=10'],
  ['a Linux laptop by battery alone', linux({ sysVendor: 'Framework', productName: 'Laptop 13', battery: true }), 'laptop', 'Framework Laptop 13', 'battery=present'],
  ['a Linux desktop by chassis', linux({ sysVendor: 'Micro-Star International Co., Ltd.', productName: 'MS-7D25', chassisType: 3 }), 'desktop', 'MSI MS-7D25', 'dmi.chassis_type=3'],
  ['a rack server by chassis', linux({ sysVendor: 'Supermicro', productName: 'SYS-1029P', chassisType: 23 }), 'server', 'Supermicro SYS-1029P', 'dmi.chassis_type=23'],
  ['a tower server by product name', linux({ sysVendor: 'Dell Inc.', productName: 'PowerEdge T150', chassisType: 7 }), 'server', 'Dell PowerEdge T150', 'dmi.product_name=PowerEdge T150'],
  ['an EC2 instance, its type as model', linux({ sysVendor: 'Amazon EC2', productName: 'c7g.2xlarge', chassisType: 1 }), 'cloud', 'AWS EC2', 'dmi.sys_vendor=Amazon EC2'],
  ['a GCE instance', linux({ sysVendor: 'Google', productName: 'Google Compute Engine' }), 'cloud', 'Google Compute Engine', 'dmi.sys_vendor=Google'],
  ['a Hetzner box', linux({ sysVendor: 'Hetzner', productName: 'vServer' }), 'cloud', 'Hetzner Cloud', 'dmi.sys_vendor=Hetzner'],
  ['a Codespace by environment', linux({}, { envNames: ['CODESPACES'] }), 'cloud', 'GitHub Codespaces', 'env=CODESPACES'],
  ['a QEMU guest', linux({ sysVendor: 'QEMU', productName: 'Standard PC (Q35 + ICH9, 2009)' }), 'vm', 'QEMU VM', 'dmi.product_name=Standard PC (Q35 + ICH9, 2009)'],
  ['a VirtualBox guest', linux({ sysVendor: 'innotek GmbH', productName: 'VirtualBox' }), 'vm', 'VirtualBox VM', 'dmi.product_name=VirtualBox'],
  ['an unnamed hypervisor by cpu flag', linux({ hypervisorFlag: true }), 'vm', 'Virtual machine', 'cpuinfo=hypervisor'],
  ['WSL 2 by kernel', linux({}, { kernel: '5.15.153.1-microsoft-standard-WSL2' }), 'vm', 'WSL 2', 'kernel=WSL2'],
  ['a Kubernetes pod by env', linux({ sysVendor: 'Amazon EC2', productName: 'm7i.large', dockerEnv: true }, { envNames: ['KUBERNETES_SERVICE_HOST'] }), 'cluster', 'Kubernetes', 'env=KUBERNETES_SERVICE_HOST'],
  ['a Kubernetes pod by cgroup', linux({ cgroup: '0::/kubepods/burstable/pod-invented' }), 'cluster', 'Kubernetes', 'cgroup=kubepods'],
  ['an E2B sandbox, even in a cluster', linux({}, { envNames: ['E2B_SANDBOX_ID', 'KUBERNETES_SERVICE_HOST'] }), 'sandbox', 'E2B sandbox', 'env=E2B_SANDBOX_ID'],
  ['a Firecracker microVM', linux({ productName: 'Firecracker' }), 'sandbox', 'Firecracker microVM', 'dmi.product_name=Firecracker'],
  ['a bare Docker container', linux({ dockerEnv: true, sysVendor: 'Amazon EC2' }), 'sandbox', 'Docker container', 'container=docker'],
  ['a Podman container', linux({}, { containerEnv: 'podman' }), 'sandbox', 'Podman container', 'container=podman'],
  ['a Windows laptop by PCSystemType', windows({ manufacturer: 'Microsoft Corporation', model: 'Surface Laptop 7', pcSystemType: 2 }), 'laptop', 'Microsoft Surface Laptop 7', 'wmi.pc_system_type=2'],
  ['a Windows server by PCSystemType', windows({ manufacturer: 'HPE', model: 'ProLiant DL360 Gen11', pcSystemType: 4 }), 'server', 'HPE ProLiant DL360 Gen11', 'wmi.pc_system_type=4'],
  ['a Windows desktop by chassis', windows({ manufacturer: 'Dell Inc.', model: 'OptiPlex 7010', pcSystemType: 1, chassisTypes: [3] }), 'desktop', 'Dell OptiPlex 7010', 'wmi.chassis_type=3'],
  ['a Windows VM by WMI model', windows({ manufacturer: 'QEMU', model: 'QEMU Virtual Machine', pcSystemType: 1 }), 'vm', 'QEMU VM', 'wmi.model=QEMU Virtual Machine'],
  ['a Hyper-V guest', windows({ manufacturer: 'Microsoft Corporation', model: 'Virtual Machine' }), 'vm', 'Hyper-V VM', 'wmi.model=Virtual Machine'],
  ['nothing to go on', base({}), 'unknown', null, '']
]

describe('the machine profile probe', () => {
  for (const [name, facts, kind, label, evidence] of CASES) {
    it(`classifies ${name}`, () => {
      const profile = classifyMachine(facts)
      assertProfile(profile)
      expect(profile.kind).toBe(kind)
      expect(profile.label).toBe(label)
      if (evidence) expect(profile.evidence).toContain(evidence)
    })
  }

  it('covers every kind', () => {
    const kinds = new Set(CASES.map(([, facts]) => classifyMachine(facts).kind))
    expect([...kinds].sort()).toEqual(['cloud', 'cluster', 'desktop', 'laptop', 'sandbox', 'server', 'unknown', 'vm'])
  })

  it('keeps the precedence sandbox > cluster > cloud > vm > physical', () => {
    const everything = linux(
      { sysVendor: 'Amazon EC2', productName: 'QEMU', chassisType: 10, hypervisorFlag: true, battery: true },
      { envNames: ['SANDBOX_ID', 'KUBERNETES_SERVICE_HOST'] }
    )
    expect(classifyMachine(everything).kind).toBe('sandbox')
    expect(classifyMachine({ ...everything, envNames: ['KUBERNETES_SERVICE_HOST'] }).kind).toBe('cluster')
    expect(classifyMachine({ ...everything, envNames: [] }).kind).toBe('cloud')
    expect(classifyMachine({ ...everything, envNames: [], linux: { ...everything.linux!, sysVendor: 'QEMU' } }).kind).toBe('vm')
  })

  it('fills the hardware facts', () => {
    const profile = classifyMachine(mac('MacBookPro18,1', true))
    expect(profile).toMatchObject({ vendor: 'Apple', model: 'MacBookPro18,1', os: 'darwin', osVersion: 'macOS 26.5', arch: 'arm64', cpus: 8, memoryGb: 16 })
    expect(classifyMachine(base({ platform: 'aix' as NodeJS.Platform })).os).toBe('other')
  })
})

describe('what a profile never carries', () => {
  const SERIAL = 'C02XK1ZZJGH5'
  const UUID = '4C4C4544-0042-3510-8051-B4C04F4D3732'
  const MAC_ADDRESS = 'a4:83:e7:12:34:56'

  it('drops identifier-shaped values wherever a vendor put them', () => {
    expect(safeFact(SERIAL)).toBeNull()
    expect(safeFact(UUID)).toBeNull()
    expect(safeFact(`host ${MAC_ADDRESS}`)).toBeNull()
    expect(safeFact('To Be Filled By O.E.M.')).toBeNull()
    expect(safeFact('MacBookPro18,1')).toBe('MacBookPro18,1')
    expect(safeFact('c7g.2xlarge')).toBe('c7g.2xlarge')
  })

  it('never lets a serial, UUID or MAC address reach the profile', () => {
    const facts = linux({ sysVendor: UUID, productName: SERIAL, chassisType: 10 }, { osVersion: MAC_ADDRESS })
    const text = JSON.stringify(classifyMachine(facts))
    for (const secret of [SERIAL, UUID, MAC_ADDRESS]) expect(text).not.toContain(secret)
  })

  it('names environment variables, never their values', () => {
    const profile = classifyMachine(linux({}, { envNames: ['E2B_SANDBOX_ID'] }))
    expect(profile.evidence).toEqual(['env=E2B_SANDBOX_ID'])
  })

  it('has no field for a host name', () => {
    const profile = classifyMachine(mac('MacBookPro18,1', true))
    expect(Object.keys(profile).sort()).toEqual(['arch', 'cpus', 'evidence', 'kind', 'label', 'memoryGb', 'model', 'os', 'osVersion', 'vendor'])
  })
})

describe('Apple model names', () => {
  it('names known ids and falls back to the family', () => {
    expect(macModel('Mac14,3')).toEqual({ label: 'Mac mini (2023)', kind: 'desktop' })
    expect(macModel('MacBookAir10,1')).toEqual({ label: 'MacBook Air (M1, 2020)', kind: 'laptop' })
    expect(macModel('MacBookPro99,1')).toEqual({ label: 'MacBook Pro', kind: 'laptop' })
    expect(macModel('Macmini99,1')).toEqual({ label: 'Mac mini', kind: 'desktop' })
    expect(macModel(null)).toEqual({ label: null, kind: null })
  })
})
