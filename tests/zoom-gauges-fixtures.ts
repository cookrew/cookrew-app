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
