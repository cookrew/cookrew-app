// WHAT KIND OF MACHINE THIS IS — the fact a level-0 figure is drawn from
// (src/shared/strata.ts · MachineProfile).
//
// Two halves. `classifyMachine` is pure: probe facts in, profile out, with the
// precedence the contract fixes:
//
//   sandbox > cluster > cloud > vm > laptop | desktop | server
//
// `readMachineFacts` asks the OS, off the main thread's critical path (async
// children with short timeouts), once per run:
//   macOS    sysctl hw.model · kern.hv_vmm_present, pmset -g batt, sw_vers
//   Linux    /sys/class/dmi/id/{sys_vendor,product_name,chassis_type},
//            /proc/1/cgroup, /.dockerenv, /run/.containerenv, cpuinfo flags,
//            a battery under /sys/class/power_supply, the environment's NAMES
//   Windows  WMI (Win32_ComputerSystem manufacturer/model/PCSystemType,
//            Win32_SystemEnclosure chassis types)
//
// NEVER READ, NEVER SENT: serial numbers, hardware UUIDs, MAC addresses, the
// hostname. No probe here asks for them, and `safeFact` drops any value that
// looks like one anyway — a vendor that stuffs a UUID into product_name must
// not get it published.

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import type { MachineKind, MachineProfile } from '../shared/strata'
import { pcIdentity, type PcIdentity } from './machine-names'
import { scrubShapes } from './scrub'

export interface MachineFacts {
  platform: NodeJS.Platform
  arch: string
  /** os.release() — the kernel; WSL says so here. */
  kernel: string
  osVersion: string | null
  cpus: number | null
  memoryBytes: number | null
  /** NAMES of the environment variables present (values never leave this module). */
  envNames: readonly string[]
  /** The `container` env var's value (podman/systemd-nspawn/docker set it), or null. */
  containerEnv: string | null
  mac?: { hwModel: string | null; battery: boolean | null; hvVmmPresent: boolean | null }
  linux?: {
    sysVendor: string | null
    productName: string | null
    /** DMI product_version: Lenovo's friendly name lives here. */
    productVersion?: string | null
    boardVendor?: string | null
    boardName?: string | null
    /** An ARM board's own name (/sys/firmware/devicetree/base/model). */
    deviceTreeModel?: string | null
    /** The chassis asset tag equals Azure's fixed one (the tag itself is never kept). */
    azure?: boolean
    chassisType: number | null
    cgroup: string | null
    dockerEnv: boolean
    containerEnvFile: boolean
    hypervisorFlag: boolean
    battery: boolean
  }
  windows?: {
    manufacturer: string | null
    model: string | null
    pcSystemType: number | null
    chassisTypes: number[]
    /** Win32_ComputerSystemProduct.Version (Lenovo's name), the baseboard, and Azure's fixed asset tag. */
    version?: string | null
    boardVendor?: string | null
    boardName?: string | null
    azure?: boolean
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const MAC_ADDRESS = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/i
/** A long run of letters and digits with no space, the shape of a serial number. */
const SERIALISH = /^(?=.*\d)(?=.*[A-Z])[A-Z0-9]{10,}$/

/** One probed string as it may be published: trimmed, short, printable, never identifier-shaped. */
export function safeFact(value: string | null | undefined, max = 64): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (clean.length === 0 || /^(?:none|default string|to be filled by o\.e\.m\.|system product name|not specified|unknown)$/i.test(clean)) return null
  if (UUID.test(clean) || MAC_ADDRESS.test(clean) || SERIALISH.test(clean)) return null
  const scrubbed = scrubShapes(clean)
  return scrubbed.length > max ? scrubbed.slice(0, max) : scrubbed
}

// ── macOS ───────────────────────────────────────────────────────────────────

/** Apple model ids we can name; the family prefix covers the rest. */
const MAC_MODELS: Readonly<Record<string, string>> = {
  'MacBookAir10,1': 'MacBook Air (M1, 2020)',
  'MacBookPro17,1': 'MacBook Pro 13-inch (M1, 2020)',
  'MacBookPro18,1': 'MacBook Pro 16-inch (2021)',
  'MacBookPro18,2': 'MacBook Pro 16-inch (2021)',
  'MacBookPro18,3': 'MacBook Pro 14-inch (2021)',
  'MacBookPro18,4': 'MacBook Pro 14-inch (2021)',
  'Macmini9,1': 'Mac mini (M1, 2020)',
  'iMac21,1': 'iMac 24-inch (M1, 2021)',
  'iMac21,2': 'iMac 24-inch (M1, 2021)',
  'Mac13,1': 'Mac Studio (2022)',
  'Mac13,2': 'Mac Studio (2022)',
  'Mac14,2': 'MacBook Air (M2, 2022)',
  'Mac14,3': 'Mac mini (2023)',
  'Mac14,5': 'MacBook Pro 14-inch (2023)',
  'Mac14,6': 'MacBook Pro 16-inch (2023)',
  'Mac14,7': 'MacBook Pro 13-inch (M2, 2022)',
  'Mac14,8': 'Mac Pro (2023)',
  'Mac14,9': 'MacBook Pro 14-inch (2023)',
  'Mac14,10': 'MacBook Pro 16-inch (2023)',
  'Mac14,12': 'Mac mini (2023)',
  'Mac14,13': 'Mac Studio (2023)',
  'Mac14,14': 'Mac Studio (2023)',
  'Mac14,15': 'MacBook Air 15-inch (M2, 2023)',
  'Mac15,3': 'MacBook Pro 14-inch (Nov 2023)',
  'Mac15,4': 'iMac 24-inch (2023)',
  'Mac15,5': 'iMac 24-inch (2023)',
  'Mac15,6': 'MacBook Pro 14-inch (Nov 2023)',
  'Mac15,7': 'MacBook Pro 16-inch (Nov 2023)',
  'Mac15,8': 'MacBook Pro 14-inch (Nov 2023)',
  'Mac15,9': 'MacBook Pro 16-inch (Nov 2023)',
  'Mac15,10': 'MacBook Pro 14-inch (Nov 2023)',
  'Mac15,11': 'MacBook Pro 16-inch (Nov 2023)',
  'Mac15,12': 'MacBook Air 13-inch (M3, 2024)',
  'Mac15,13': 'MacBook Air 15-inch (M3, 2024)',
  'Mac16,1': 'MacBook Pro 14-inch (2024)',
  'Mac16,5': 'MacBook Pro 16-inch (2024)',
  'Mac16,6': 'MacBook Pro 14-inch (2024)',
  'Mac16,7': 'MacBook Pro 16-inch (2024)',
  'Mac16,8': 'MacBook Pro 14-inch (2024)',
  'Mac16,10': 'Mac mini (2024)',
  'Mac16,11': 'Mac mini (2024)',
  'Mac16,2': 'iMac 24-inch (2024)',
  'Mac16,3': 'iMac 24-inch (2024)',
  'Mac16,9': 'Mac Studio (2025)',
  'Mac15,14': 'Mac Studio (2025)',
  'Mac16,12': 'MacBook Air 13-inch (M4, 2025)',
  'Mac16,13': 'MacBook Air 15-inch (M4, 2025)',
  'MacPro7,1': 'Mac Pro (2019)',
  'iMac20,1': 'iMac 27-inch (2020)',
  'iMac20,2': 'iMac 27-inch (2020)',
  'Macmini8,1': 'Mac mini (2018)'
}

const MAC_FAMILIES: ReadonlyArray<[prefix: string, label: string, kind: MachineKind | null]> = [
  ['MacBookPro', 'MacBook Pro', 'laptop'],
  ['MacBookAir', 'MacBook Air', 'laptop'],
  ['MacBook', 'MacBook', 'laptop'],
  ['Macmini', 'Mac mini', 'desktop'],
  ['MacPro', 'Mac Pro', 'desktop'],
  ['iMac', 'iMac', 'desktop'],
  ['Xserve', 'Xserve', 'server'],
  ['VirtualMac', 'macOS virtual machine', 'vm'],
  ['Mac', 'Mac', null]
]

/** Label and (when the name says) kind for an Apple model id. */
export function macModel(hwModel: string | null): { label: string | null; kind: MachineKind | null } {
  if (!hwModel) return { label: null, kind: null }
  const named = MAC_MODELS[hwModel]
  if (named) return { label: named, kind: /^MacBook/.test(named) ? 'laptop' : 'desktop' }
  const family = MAC_FAMILIES.find(([prefix]) => hwModel.startsWith(prefix))
  return family ? { label: family[1], kind: family[2] } : { label: null, kind: null }
}

// ── the rules ───────────────────────────────────────────────────────────────

/** Environment NAMES that say a sandbox runtime launched this process. */
const SANDBOX_ENV: ReadonlyArray<[name: string, label: string]> = [
  ['E2B_SANDBOX_ID', 'E2B sandbox'],
  ['E2B_SANDBOX', 'E2B sandbox'],
  ['DAYTONA_SANDBOX_ID', 'Daytona sandbox'],
  ['DAYTONA_WS_ID', 'Daytona sandbox'],
  ['MODAL_TASK_ID', 'Modal sandbox'],
  ['CODESANDBOX_HOST', 'CodeSandbox'],
  ['SANDBOX_ID', 'Sandbox']
]

const CLUSTER_ENV = ['KUBERNETES_SERVICE_HOST']

/** Environment NAMES a cloud host sets. */
const CLOUD_ENV: ReadonlyArray<[name: string, label: string, vendor: string]> = [
  ['CODESPACES', 'GitHub Codespaces', 'GitHub'],
  ['FLY_MACHINE_ID', 'Fly.io machine', 'Fly.io'],
  ['RAILWAY_ENVIRONMENT', 'Railway', 'Railway'],
  ['RENDER_SERVICE_ID', 'Render', 'Render'],
  ['GITPOD_WORKSPACE_ID', 'Gitpod workspace', 'Gitpod'],
  ['AWS_EXECUTION_ENV', 'AWS', 'Amazon']
]

/** DMI / WMI vendor or product text → a cloud. Matched case-insensitively against vendor + product. */
const CLOUD_DMI: ReadonlyArray<[pattern: RegExp, label: string]> = [
  [/amazon ec2/i, 'AWS EC2'],
  [/google compute engine|^google$/i, 'Google Compute Engine'],
  [/digitalocean/i, 'DigitalOcean Droplet'],
  [/hetzner/i, 'Hetzner Cloud'],
  [/alibaba cloud/i, 'Alibaba Cloud ECS'],
  [/openstack/i, 'OpenStack instance'],
  [/scaleway/i, 'Scaleway instance'],
  [/vultr/i, 'Vultr instance'],
  [/linode|akamai/i, 'Linode instance'],
  [/oraclecloud|oracle cloud/i, 'Oracle Cloud instance'],
  [/tencent cloud/i, 'Tencent Cloud CVM']
]

/** DMI / WMI vendor or product text → a hypervisor. */
const VM_DMI: ReadonlyArray<[pattern: RegExp, label: string]> = [
  [/virtualbox|innotek/i, 'VirtualBox VM'],
  [/vmware/i, 'VMware VM'],
  [/parallels/i, 'Parallels VM'],
  [/qemu|bochs|standard pc \(/i, 'QEMU VM'],
  [/\bkvm\b/i, 'KVM VM'],
  [/\bxen\b/i, 'Xen VM'],
  [/microsoft corporation.*virtual machine|^virtual machine$/i, 'Hyper-V VM'],
  [/apple virtualization|virtualmac/i, 'macOS virtual machine'],
  [/\butm\b/i, 'UTM VM']
]

const SERVER_PRODUCTS = /poweredge|proliant|thinksystem|primergy|supermicro|ucs |rack|blade|server/i

/** SMBIOS chassis types (DSP0134 §7.4.1). */
const CHASSIS_LAPTOP = new Set([8, 9, 10, 11, 14, 30, 31, 32])
const CHASSIS_SERVER = new Set([17, 23, 25, 28, 29])
const CHASSIS_DESKTOP = new Set([3, 4, 5, 6, 7, 13, 15, 16, 24, 34, 35, 36])

/** Win32_ComputerSystem.PCSystemType. */
const PC_SYSTEM_LAPTOP = 2
const PC_SYSTEM_SERVERS = new Set([4, 5, 7])

const osOf = (platform: NodeJS.Platform): MachineProfile['os'] =>
  platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : 'other'

interface Verdict {
  kind: MachineKind
  label: string | null
  vendor: string | null
  model: string | null
}

/** The most specific kind the facts support, and the evidence that decided it. */
export function classifyMachine(facts: MachineFacts): MachineProfile {
  const evidence: string[] = []
  const say = (fact: string): void => {
    const safe = safeFact(fact, 96)
    if (safe && !evidence.includes(safe)) evidence.push(safe)
  }
  const verdict = decide(facts, say)
  return {
    kind: verdict.kind,
    model: safeFact(verdict.model),
    label: safeFact(verdict.label),
    vendor: safeFact(verdict.vendor),
    os: osOf(facts.platform),
    osVersion: safeFact(facts.osVersion),
    arch: safeFact(facts.arch, 16) ?? 'unknown',
    cpus: typeof facts.cpus === 'number' && facts.cpus > 0 ? facts.cpus : null,
    memoryGb: typeof facts.memoryBytes === 'number' && facts.memoryBytes > 0 ? Math.round(facts.memoryBytes / 2 ** 30) : null,
    evidence
  }
}

function decide(facts: MachineFacts, say: (fact: string) => void): Verdict {
  const env = new Set(facts.envNames)
  const linux = facts.linux
  const win = facts.windows
  const mac = facts.mac
  // Raw strings for recognising a cloud or a hypervisor; friendly ones for the caption.
  const vendor = linux?.sysVendor ?? win?.manufacturer ?? (mac ? 'Apple' : null)
  const product = linux?.productName ?? win?.model ?? mac?.hwModel ?? null
  const hardware = [vendor, product].filter(Boolean).join(' ')
  const pc = pcIdentity({
    vendor,
    product,
    version: linux?.productVersion ?? win?.version,
    boardVendor: linux?.boardVendor ?? win?.boardVendor,
    boardName: linux?.boardName ?? win?.boardName,
    deviceTree: linux?.deviceTreeModel
  })

  // sandbox: a sandbox runtime said so, or the hardware is a microVM
  const sandboxEnv = SANDBOX_ENV.find(([name]) => env.has(name))
  if (sandboxEnv) {
    say(`env=${sandboxEnv[0]}`)
    return { kind: 'sandbox', label: sandboxEnv[1], vendor: null, model: null }
  }
  if (/firecracker/i.test(hardware) || /firecracker/i.test(linux?.cgroup ?? '')) {
    say(/firecracker/i.test(hardware) ? `dmi.product_name=${product}` : 'cgroup=firecracker')
    return { kind: 'sandbox', label: 'Firecracker microVM', vendor: null, model: 'firecracker' }
  }

  // cluster: an orchestrator manages this process
  const clusterEnv = CLUSTER_ENV.find((name) => env.has(name))
  if (clusterEnv || /kubepods/.test(linux?.cgroup ?? '')) {
    say(clusterEnv ? `env=${clusterEnv}` : 'cgroup=kubepods')
    return { kind: 'cluster', label: 'Kubernetes', vendor: cloudLabel(hardware) ?? null, model: null }
  }

  // a bare container no orchestrator manages is drawn as a sandbox
  const container = containerOf(facts)
  if (container) {
    say(`container=${container}`)
    return { kind: 'sandbox', label: `${container[0].toUpperCase()}${container.slice(1)} container`, vendor: null, model: null }
  }

  // cloud: the firmware or the environment names a provider
  const cloud = cloudLabel(hardware)
  if (cloud) {
    say(linux ? `dmi.sys_vendor=${vendor}` : `wmi.manufacturer=${vendor}`)
    // On EC2 Nitro the product name IS the instance type (c7g.2xlarge); a
    // product that only names the cloud again ('Google Compute Engine') is no model.
    const model = pc.model !== null && cloudLabel(pc.model) === null ? pc.model : null
    return { kind: 'cloud', label: cloud, vendor: pc.vendor, model }
  }
  if (linux?.azure || win?.azure) {
    say('chassis_asset_tag=azure')
    return { kind: 'cloud', label: 'Azure VM', vendor: 'Microsoft', model: null }
  }
  const cloudEnv = CLOUD_ENV.find(([name]) => env.has(name))
  if (cloudEnv) {
    say(`env=${cloudEnv[0]}`)
    return { kind: 'cloud', label: cloudEnv[1], vendor: cloudEnv[2], model: null }
  }

  // vm: a hypervisor is present
  if (mac?.hvVmmPresent || /^VirtualMac/.test(mac?.hwModel ?? '')) {
    say(mac?.hvVmmPresent ? 'kern.hv_vmm_present=1' : `hw.model=${mac?.hwModel}`)
    return { kind: 'vm', label: 'macOS virtual machine', vendor: 'Apple', model: mac?.hwModel ?? null }
  }
  if (/microsoft-standard-wsl|-microsoft$/i.test(facts.kernel)) {
    say('kernel=WSL2')
    return { kind: 'vm', label: 'WSL 2', vendor: 'Microsoft', model: null }
  }
  const hypervisor = VM_DMI.find(([pattern]) => pattern.test(hardware))
  if (hypervisor) {
    say(win ? `wmi.model=${product}` : `dmi.product_name=${product}`)
    return { kind: 'vm', label: hypervisor[1], vendor: pc.vendor, model: pc.model }
  }
  if (linux?.hypervisorFlag) {
    say('cpuinfo=hypervisor')
    return { kind: 'vm', label: 'Virtual machine', vendor: pc.vendor, model: pc.model }
  }

  // physical: laptop | desktop | server
  if (mac) return macKind(mac, say)
  if (linux) return chassisKind(linux.chassisType, linux.battery, pc, 'dmi', say)
  if (win) {
    if (win.pcSystemType === PC_SYSTEM_LAPTOP) {
      say(`wmi.pc_system_type=${win.pcSystemType}`)
      return { kind: 'laptop', ...pc }
    }
    if (win.pcSystemType !== null && PC_SYSTEM_SERVERS.has(win.pcSystemType)) {
      say(`wmi.pc_system_type=${win.pcSystemType}`)
      return { kind: 'server', ...pc }
    }
    return chassisKind(win.chassisTypes[0] ?? null, false, pc, 'wmi', say)
  }
  return { kind: 'unknown', ...pc }
}

function cloudLabel(hardware: string): string | null {
  return CLOUD_DMI.find(([pattern]) => pattern.test(hardware))?.[1] ?? null
}

function containerOf(facts: MachineFacts): string | null {
  const linux = facts.linux
  if (facts.containerEnv) return safeFact(facts.containerEnv, 24)?.toLowerCase() ?? 'container'
  if (linux?.containerEnvFile) return 'podman'
  if (linux?.dockerEnv || /\/docker[/-]/.test(linux?.cgroup ?? '')) return 'docker'
  if (/\/lxc[/.]/.test(linux?.cgroup ?? '')) return 'lxc'
  return null
}

function macKind(mac: NonNullable<MachineFacts['mac']>, say: (fact: string) => void): Verdict {
  const named = macModel(mac.hwModel)
  if (mac.hwModel) say(`hw.model=${mac.hwModel}`)
  if (mac.battery !== null) say(`battery=${mac.battery ? 'present' : 'absent'}`)
  // The battery is the decider whenever it answered: a MacBook has one, a
  // Mac mini does not, and Apple's newer ids (Mac15,3) do not say which.
  const kind: MachineKind = mac.battery === true ? 'laptop' : mac.battery === false ? (named.kind === 'server' ? 'server' : 'desktop') : (named.kind ?? 'unknown')
  return { kind, label: named.label, vendor: 'Apple', model: mac.hwModel }
}

function chassisKind(chassis: number | null, battery: boolean, pc: PcIdentity, source: 'dmi' | 'wmi', say: (fact: string) => void): Verdict {
  const product = pc.model
  if (chassis !== null) say(`${source}.chassis_type=${chassis}`)
  if (battery) say('battery=present')
  if ((chassis !== null && CHASSIS_LAPTOP.has(chassis)) || battery) return { kind: 'laptop', ...pc }
  if ((chassis !== null && CHASSIS_SERVER.has(chassis)) || SERVER_PRODUCTS.test(product ?? '')) {
    if (product && SERVER_PRODUCTS.test(product)) say(`${source}.product_name=${product}`)
    return { kind: 'server', ...pc }
  }
  if (chassis !== null && CHASSIS_DESKTOP.has(chassis)) return { kind: 'desktop', ...pc }
  return { kind: 'unknown', ...pc }
}

// ── reading the facts ───────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 3_000

/** The fixed SMBIOS asset tag every Azure VM carries (public, the same on all of them). */
const AZURE_ASSET_TAG = '7783-7084-3265-9085-8269-3286-77'

function run(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, [...args], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim())
    })
  })
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
}

/** Only these env NAMES are ever looked at; their values stay where they are. */
const WATCHED_ENV = [...SANDBOX_ENV.map(([n]) => n), ...CLUSTER_ENV, ...CLOUD_ENV.map(([n]) => n)]

async function readMac(): Promise<NonNullable<MachineFacts['mac']>> {
  const [hwModel, hv, batt] = await Promise.all([
    run('sysctl', ['-n', 'hw.model']),
    run('sysctl', ['-n', 'kern.hv_vmm_present']),
    run('pmset', ['-g', 'batt'])
  ])
  return {
    hwModel: hwModel || null,
    hvVmmPresent: hv === null ? null : hv === '1',
    // `pmset -g batt` lists "-InternalBattery-0" on a machine that has one.
    battery: batt === null ? null : /InternalBattery/i.test(batt)
  }
}

function readLinux(): NonNullable<MachineFacts['linux']> {
  const dmi = (name: string): string | null => readText(`/sys/class/dmi/id/${name}`)
  const chassis = Number.parseInt(dmi('chassis_type') ?? '', 10)
  let battery = false
  try {
    battery = readdirSync('/sys/class/power_supply').some((entry) => /^BAT/i.test(entry))
  } catch {
    battery = false
  }
  const cpuinfo = readText('/proc/cpuinfo') ?? ''
  return {
    sysVendor: dmi('sys_vendor'),
    productName: dmi('product_name'),
    productVersion: dmi('product_version'),
    boardVendor: dmi('board_vendor'),
    boardName: dmi('board_name'),
    deviceTreeModel: readText('/sys/firmware/devicetree/base/model'),
    // Compared here and dropped: an asset tag elsewhere can be an inventory number.
    azure: dmi('chassis_asset_tag') === AZURE_ASSET_TAG,
    chassisType: Number.isFinite(chassis) ? chassis : null,
    cgroup: readText('/proc/1/cgroup'),
    dockerEnv: existsSync('/.dockerenv'),
    containerEnvFile: existsSync('/run/.containerenv'),
    hypervisorFlag: /^flags\s*:.*\bhypervisor\b/m.test(cpuinfo),
    battery
  }
}

function linuxOsVersion(): string | null {
  const release = readText('/etc/os-release') ?? ''
  const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(release)
  return pretty ? pretty[1] : null
}

async function readWindows(): Promise<NonNullable<MachineFacts['windows']>> {
  // Select-Object names the members: Win32_ComputerSystem also carries the
  // host name, and the product, enclosure and baseboard classes carry serial
  // numbers and a UUID — nothing here may read them. The asset tag is compared
  // with Azure's fixed one in PowerShell and only the boolean comes back.
  const script =
    '$c = Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,PCSystemType; ' +
    '$e = Get-CimInstance Win32_SystemEnclosure | Select-Object ChassisTypes,SMBIOSAssetTag; ' +
    '$p = Get-CimInstance Win32_ComputerSystemProduct | Select-Object Version; ' +
    '$b = Get-CimInstance Win32_BaseBoard | Select-Object Manufacturer,Product; ' +
    `@{ m = $c.Manufacturer; model = $c.Model; t = $c.PCSystemType; ch = @($e.ChassisTypes); v = $p.Version; bm = $b.Manufacturer; bp = $b.Product; az = ($e.SMBIOSAssetTag -eq '${AZURE_ASSET_TAG}') } | ConvertTo-Json -Compress`
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  try {
    const parsed = JSON.parse(out ?? '') as { m?: string; model?: string; t?: number; ch?: number[]; v?: string; bm?: string; bp?: string; az?: boolean }
    return {
      manufacturer: parsed.m ?? null,
      model: parsed.model ?? null,
      pcSystemType: typeof parsed.t === 'number' ? parsed.t : null,
      chassisTypes: Array.isArray(parsed.ch) ? parsed.ch.filter((n) => typeof n === 'number') : [],
      version: parsed.v ?? null,
      boardVendor: parsed.bm ?? null,
      boardName: parsed.bp ?? null,
      azure: parsed.az === true
    }
  } catch {
    return { manufacturer: null, model: null, pcSystemType: null, chassisTypes: [] }
  }
}

export async function readMachineFacts(env: NodeJS.ProcessEnv = process.env): Promise<MachineFacts> {
  const platform = process.platform
  const base: MachineFacts = {
    platform,
    arch: process.arch,
    kernel: os.release(),
    osVersion: null,
    cpus: os.cpus().length || null,
    memoryBytes: os.totalmem(),
    envNames: WATCHED_ENV.filter((name) => typeof env[name] === 'string'),
    containerEnv: typeof env.container === 'string' ? env.container : null
  }
  if (platform === 'darwin') {
    const [mac, version] = await Promise.all([readMac(), run('sw_vers', ['-productVersion'])])
    return { ...base, mac, osVersion: version ? `macOS ${version}` : null }
  }
  if (platform === 'linux') return { ...base, linux: readLinux(), osVersion: linuxOsVersion() }
  if (platform === 'win32') return { ...base, windows: await readWindows(), osVersion: `Windows ${os.release()}` }
  return base
}

/** The profile before the probe has answered: honest about knowing nothing yet. */
export function provisionalProfile(): MachineProfile {
  return {
    kind: 'unknown',
    model: null,
    label: null,
    vendor: null,
    os: osOf(process.platform),
    osVersion: null,
    arch: process.arch,
    cpus: os.cpus().length || null,
    memoryGb: Math.round(os.totalmem() / 2 ** 30) || null,
    evidence: []
  }
}

let probed: Promise<MachineProfile> | null = null

/** This machine's profile, probed once per run. Never rejects. */
export function machineProfile(): Promise<MachineProfile> {
  probed ??= readMachineFacts()
    .then(classifyMachine)
    .catch((error: unknown) => {
      console.error('Machine profile probe failed:', error)
      return provisionalProfile()
    })
  return probed
}
