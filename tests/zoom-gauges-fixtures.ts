// What the machine really says, kept verbatim, so a parser is tested against
// the OS and not against what its author remembered. `ioreg`, `sysctl` from
// the owner's Mac (M1 Pro, 16 GB, 2026-11-05, mid swap storm); /proc from a
// Linux box; `nvidia-smi` from its man page's csv form.

export const IOREG_APPLE = `+-o AGXAcceleratorG13X  <class AGXAcceleratorG13X, id 0x10000094a, registered, matched, active, busy 0 (21299 ms), retain 44>
    {
      "SchedulerState" = {"Stamps"=(),"BusyWorkQueues"=()}
      "vendor-id" = <6b100000>
      "AGCInfo" = {"fLastSubmissionPID"=44440,"fSubmissionsSinceLastCheck"=0,"fBusyCount"=0}
      "IONameMatched" = "gpu,t6000"
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=2129903616,"Tiler Utilization %"=4,"recoveryCount"=0,"lastRecoveryTime"=0,"Renderer Utilization %"=9,"TiledSceneBytes"=360448,"Device Utilization %"=23,"SplitSceneCount"=0,"Allocated PB Size"=191889408,"In use system memory"=1048576}
      "model" = "Apple M1 Pro"
      "gpu-core-count" = 16
    }
`

/** A MacBook Pro with both GPUs: the discrete one is doing the work. */
export const IOREG_TWO_GPUS = `+-o AppleIntelFramebuffer  <class IntelAccelerator>
    {
      "PerformanceStatistics" = {"Device Utilization %"=3,"GPU Core Utilization"=3000000}
    }
+-o AMDRadeonX6000  <class AMDRadeonX6000_AMDNavi10GraphicsAccelerator>
    {
      "PerformanceStatistics" = {"Device Utilization %"=61,"Tiler Utilization %"=12}
    }
`

/** A virtual Mac: the accelerator class exists and reports no statistics. */
export const IOREG_NO_STATISTICS = `+-o AppleParavirtGPU  <class AppleParavirtGPU, id 0x100000401>
    {
      "IOClass" = "AppleParavirtGPU"
      "model" = "Apple Paravirtual device"
    }
`

export const SYSCTL_STORM = `vm.swapusage: total = 10240.00M  used = 8981.12M  free = 1258.88M  (encrypted)
kern.memorystatus_vm_pressure_level: 2
vm.page_free_count: 906
vm.page_speculative_count: 10976
vm.page_purgeable_count: 661
vm.page_pageable_external_count: 88829
hw.pagesize: 16384
`

export const SYSCTL_CALM = `vm.swapusage: total = 1024.00M  used = 0.00M  free = 1024.00M  (encrypted)
kern.memorystatus_vm_pressure_level: 1
vm.page_free_count: 400000
vm.page_speculative_count: 20000
vm.page_purgeable_count: 1000
vm.page_pageable_external_count: 100000
hw.pagesize: 16384
`

/** An unknown oid is an error on stderr and the rest still answer. */
export const SYSCTL_SWAP_ONLY = `vm.swapusage: total = 5120.00M  used = 3591.06M  free = 1528.94M  (encrypted)
`

export const SYSCTL_GIGABYTES = `vm.swapusage: total = 14.30G  used = 13.60G  free = 0.70G  (encrypted)
kern.memorystatus_vm_pressure_level: 4
`

export const PROC_STAT_A = `cpu  4705 150 1120 16250 520 0 30 12 0 0
cpu0 1393 50 351 8125 260 0 15 6 0 0
cpu1 3312 100 769 8125 260 0 15 6 0 0
intr 114930548 113199788 3 0 5 263 0 4 [... 39 more]
ctxt 1990473
btime 1062191376
processes 2915
`

/** One second later: 300 busy jiffies, 100 idle, 100 waiting on the disk. */
export const PROC_STAT_B = `cpu  4905 150 1220 16350 620 0 30 12 0 0
cpu0 1493 50 401 8175 310 0 15 6 0 0
cpu1 3412 100 819 8175 310 0 15 6 0 0
intr 114930548 113199788 3 0 5 263 0 4 [... 39 more]
`

export const PROC_MEMINFO = `MemTotal:       16303428 kB
MemFree:          235520 kB
MemAvailable:    6291456 kB
Buffers:          102400 kB
Cached:          5120000 kB
SwapCached:        10240 kB
SwapTotal:       8388604 kB
SwapFree:        4194300 kB
`

/** A kernel before 3.14 has no MemAvailable, and a box may have no swap at all. */
export const PROC_MEMINFO_OLD = `MemTotal:        8000000 kB
MemFree:         1000000 kB
Buffers:          500000 kB
Cached:          1500000 kB
SwapTotal:             0 kB
SwapFree:              0 kB
`

export const NVIDIA_SMI_ONE = `37
`
export const NVIDIA_SMI_TWO = `12
88
`
/** A passively cooled card with no counter. */
export const NVIDIA_SMI_NA = `[N/A]
`

/** /sys/class/drm on Solis-Core, an EC2 box: the hypervisor's VGA (lspci: Amazon 1111) has a card, and no driver counts it busy. */
export const DRM_EC2 = ['card0', 'card0-Virtual-1', 'version']
/** A box with two amdgpu cards: the connectors and render nodes beside them are not cards. */
export const DRM_TWO_AMD = ['card0', 'card0-DP-1', 'card1', 'card1-HDMI-A-1', 'renderD128', 'renderD129', 'version']
/** A card's device directory when its driver counts busy time (amdgpu), and when it does not. */
export const DRM_DEVICE_COUNTS = ['boot_vga', 'device', 'driver', 'gpu_busy_percent', 'mem_busy_percent', 'vendor']
export const DRM_DEVICE_SILENT = ['boot_vga', 'device', 'driver', 'vendor']

/** card0's device/uevent on an EC2 box: the firmware's framebuffer, a picture and nothing to compute with. */
export const UEVENT_SIMPLEDRM = `DRIVER=simple-framebuffer
MODALIAS=platform:simple-framebuffer
`
/** The same Amazon VGA (lspci 1d0f:1111) if a plain driver ever binds it. */
export const UEVENT_AMAZON_VGA = `PCI_CLASS=30000
PCI_ID=1D0F:1111
PCI_SLOT_NAME=0000:00:03.0
`
/** A server's BMC display. */
export const UEVENT_ASPEED = `DRIVER=ast
PCI_CLASS=30000
PCI_ID=1A03:2000
PCI_SLOT_NAME=0000:02:00.0
`
export const UEVENT_AMDGPU = `DRIVER=amdgpu
PCI_CLASS=30000
PCI_ID=1002:73BF
PCI_SUBSYS_ID=1DA2:E445
PCI_SLOT_NAME=0000:03:00.0
MODALIAS=pci:v00001002d000073BFsv00001DA2sd0000E445bc03sc00i00
`
/** An Intel laptop: a real GPU whose driver keeps no gpu_busy_percent. */
export const UEVENT_I915 = `DRIVER=i915
PCI_CLASS=30000
PCI_ID=8086:9A49
PCI_SLOT_NAME=0000:00:02.0
`
export const UEVENT_NVIDIA = `DRIVER=nvidia
PCI_CLASS=30000
PCI_ID=10DE:1EB8
PCI_SLOT_NAME=0000:00:1e.0
`
/** nvidia-smi on a CPU instance built from a GPU image: the tool is there, the card is not. It exits 6 and says so on stdout. */
export const NVIDIA_SMI_NO_DEVICES = `No devices were found
`

/** /sys/bus/pci/devices on Solis-Core: host bridge, the Amazon VGA, NVMe, ENA. `class` and `vendor` per device. */
export const PCI_EC2: Record<string, { class: string; vendor: string }> = {
  '0000:00:00.0': { class: '0x060000\n', vendor: '0x8086\n' },
  '0000:00:03.0': { class: '0x030000\n', vendor: '0x1d0f\n' },
  '0000:00:04.0': { class: '0x010802\n', vendor: '0x1d0f\n' },
  '0000:00:05.0': { class: '0x020000\n', vendor: '0x1d0f\n' }
}
/** A g4dn before its NVIDIA driver is installed: the T4 is on the bus as a 3D controller, and no driver has made a card of it. */
export const PCI_G4DN_NO_DRIVER: Record<string, { class: string; vendor: string }> = {
  ...PCI_EC2,
  '0000:00:1e.0': { class: '0x030200\n', vendor: '0x10de\n' }
}
