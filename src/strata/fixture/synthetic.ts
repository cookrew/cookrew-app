// The committed preview fleet: invented machines, workspaces and agents only
// (the real one comes from scratchpad/strata/make-fixture.mjs and stays
// out of git). Deterministic for a given seed so stills and tests are stable.
// It covers every MachineKind, an offline machine with a cache, one never
// reached, background workspaces, a 48-agent workspace and an agent with 40
// attachments. Exactly one workspace per machine is focused, as on a desktop.
import type {
  AgentPhase,
  Harness,
  LevelsAgent,
  LevelsAttachment,
  LevelsSnapshot,
  LevelsWorkspace,
  MachineKind,
  MachineProfile
} from '../../shared/strata'

/** One machine as the preview server holds it: the registry row's facts plus its levels. */
export interface FixtureMachine {
  id: string
  name: string
  online: boolean
  lastSeenAt: number | null
  appVersion: string | null
  profile: MachineProfile | null
  levels: LevelsSnapshot | null
}

const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const NAMES = [
  'Ada', 'Basil', 'Cleo', 'Dune', 'Echo', 'Fern', 'Gus', 'Hazel', 'Iris', 'Juno', 'Kip', 'Lumen', 'Moss', 'Nell',
  'Otto', 'Pip', 'Quill', 'Rook', 'Sage', 'Tansy', 'Umber', 'Vale', 'Wren', 'Xan', 'Yarrow', 'Zinc', 'Alder',
  'Birch', 'Cobalt', 'Dahlia', 'Ember', 'Flint', 'Garnet', 'Heath', 'Indigo', 'Jade', 'Kestrel', 'Larch', 'Marl',
  'Nimbus', 'Onyx', 'Pike', 'Quartz', 'Rowan', 'Slate', 'Thorn', 'Ulex', 'Vetch'
]
const TASKS = [
  'Refactor the upload queue so retries back off',
  'Write tests for the CSV parser edge cases',
  'Profile the cold start and cut the bundle',
  'Draft the release notes for 0.4',
  'Port the settings page to the new form kit',
  'Find why the nightly job double-sends email',
  'Review the auth middleware diff',
  'Migrate the cron jobs to the queue',
  'Tidy the dotfiles and document the install',
  'Summarise yesterday’s incident timeline'
]
const REPLIES = [
  'Done — 14 tests added, all green.',
  'Found it: the retry ran inside the transaction.',
  'Bundle down from 412 KB to 268 KB.',
  'Two options below; I recommend the first.',
  'Blocked: the staging token expired.',
  'Pushed to the lane branch, ready to land.'
]
const HOSTS = ['github.com/acme/app/pull/482', 'localhost:5280', 'docs.example.dev/queue', 'grafana.example.dev/d/latency', 'file · report.html']
const HARNESSES: Harness[] = ['claude', 'claude', 'claude', 'codex', 'opencode', 'pi', 'shell']
const MODELS: Record<Harness, Array<string | null>> = {
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', null],
  codex: ['gpt-5.6', null],
  opencode: [null],
  pi: [null],
  shell: [null],
  other: [null]
}

interface MachineSpec {
  id: string
  name: string
  kind: MachineKind
  model: string | null
  label: string | null
  vendor: string | null
  os: MachineProfile['os']
  arch: string
  evidence: string[]
  /** null = online now; a number = offline for that long; 'never' = registered, never reached. */
  away: number | null | 'never'
  /** The first one is the focused workspace. */
  workspaces: Array<[name: string, agents: number]>
}

const DAY = 24 * 60 * 60 * 1000
const SPECS: MachineSpec[] = [
  {
    id: 'syn-studio', name: 'studio', kind: 'desktop', model: 'Mac14,12', label: 'Mac mini (2023)', vendor: 'Apple',
    os: 'darwin', arch: 'arm64', evidence: ['hw.model=Mac14,12', 'battery=absent'], away: null,
    workspaces: [['Monorepo', 48], ['Paper Notes', 9], ['Home Lab', 2]]
  },
  {
    id: 'syn-cloud', name: 'night-runner', kind: 'cloud', model: 'c7g.2xlarge', label: 'AWS EC2', vendor: 'Amazon EC2',
    os: 'linux', arch: 'arm64', evidence: ['dmi.sys_vendor=Amazon EC2'], away: null,
    workspaces: [['CI Night Shift', 6], ['Data Pipes', 3]]
  },
  {
    id: 'syn-cluster', name: 'batch-pool', kind: 'cluster', model: 'EKS 1.31 · 5 nodes', label: 'Kubernetes', vendor: 'AWS',
    os: 'linux', arch: 'x64', evidence: ['env=KUBERNETES_SERVICE_HOST'], away: null,
    workspaces: [['Batch Jobs', 14]]
  },
  {
    id: 'syn-sandbox', name: 'scratch', kind: 'sandbox', model: 'firecracker', label: 'Sandbox', vendor: null,
    os: 'linux', arch: 'x64', evidence: ['env=SANDBOX_ID', 'cgroup=firecracker'], away: null,
    workspaces: [['Throwaway', 1]]
  },
  {
    id: 'syn-server', name: 'basement', kind: 'server', model: 'PowerEdge T150', label: 'Dell tower', vendor: 'Dell Inc.',
    os: 'linux', arch: 'x64', evidence: ['dmi.chassis_type=7'], away: null,
    workspaces: [['Media', 2], ['Backups', 1]]
  },
  {
    id: 'syn-laptop', name: 'old-thinkpad', kind: 'laptop', model: '20XW', label: 'ThinkPad X1 Carbon', vendor: 'LENOVO',
    os: 'linux', arch: 'x64', evidence: ['dmi.chassis_type=10'], away: 3 * DAY,
    workspaces: [['Thesis', 3], ['Dotfiles', 1]]
  },
  {
    id: 'syn-vm', name: 'win-test', kind: 'vm', model: 'UTM', label: 'Windows 11 VM', vendor: 'QEMU',
    os: 'win32', arch: 'arm64', evidence: ['wmi.model=QEMU Virtual Machine'], away: 'never',
    workspaces: []
  }
]

const pick = <T>(rand: () => number, list: readonly T[]): T => list[Math.floor(rand() * list.length)]

const phaseFor = (rand: () => number): AgentPhase => {
  const r = rand()
  return r < 0.25 ? 'thinking' : r < 0.33 ? 'waiting' : r < 0.48 ? 'replied' : 'idle'
}

const attachmentsFor = (rand: () => number, agentId: string, heavy: boolean): LevelsAttachment[] => {
  const count = heavy ? 40 : Math.floor(rand() * rand() * 7)
  return Array.from({ length: count }, (_, i) =>
    rand() < 0.45
      ? { id: `${agentId}-n${i}`, kind: 'note' as const, title: `${pick(rand, TASKS).split(' ').slice(0, 4).join(' ')} — notes`, shared: false, owner: true }
      : { id: `${agentId}-b${i}`, kind: 'browser' as const, title: pick(rand, ['PR', 'Preview', 'Docs', 'Dashboard', 'Report']), host: pick(rand, HOSTS), tabs: 1 + Math.floor(rand() * 3), shared: false, owner: true }
  )
}

const workspaceFor = (rand: () => number, machineId: string, index: number, [name, size]: MachineSpec['workspaces'][number], now: number): LevelsWorkspace => {
  const id = `${machineId}-w${index}`
  const agents: LevelsAgent[] = Array.from({ length: size }, (_, i) => {
    const harness = pick(rand, HARNESSES)
    const phase = phaseFor(rand)
    const agentId = `${id}-a${i}`
    return {
      id: agentId,
      name: NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : ''),
      harness,
      model: pick(rand, MODELS[harness]),
      orch: i === 0 && size > 3,
      phase,
      phaseSource: index === 0 ? 'live' : 'probe',
      phaseSince: now - Math.floor(rand() * 40 * 60 * 1000),
      task: harness === 'shell' ? null : pick(rand, TASKS),
      reply: phase === 'replied' || phase === 'idle' ? pick(rand, REPLIES) : null,
      status: phase === 'thinking' ? `Working… (${Math.floor(rand() * 300)}s)` : null,
      turns: Math.floor(rand() * 60),
      attachments: attachmentsFor(rand, agentId, size >= 9 && i === 1)
    }
  })
  // Two agents share one note so the "shared" chip has something to show.
  const shared: LevelsAttachment = { id: `${id}-shared`, kind: 'note', title: 'Team plan', shared: true }
  const wired = agents.map((agent, i) =>
    i < 2 && agents.length > 2 ? { ...agent, attachments: [{ ...shared, owner: i === 0 }, ...agent.attachments] } : agent
  )
  const loose: LevelsAttachment[] = size > 5 ? [{ id: `${id}-loose`, kind: 'browser', title: 'Scratch', host: 'example.dev', tabs: 1, shared: false }] : []
  const all = [...wired.flatMap((a) => a.attachments), ...loose]
  const unique = new Map(all.map((a) => [a.id, a]))
  return {
    id,
    name,
    icon: null,
    state: index === 0 ? 'focused' : 'background',
    agents: wired,
    loose,
    counts: {
      agents: wired.length,
      notes: [...unique.values()].filter((a) => a.kind === 'note').length,
      browsers: [...unique.values()].filter((a) => a.kind === 'browser').length
    }
  }
}

export const syntheticFleet = (now: number, seed = 21): FixtureMachine[] => {
  const rand = mulberry32(seed)
  return SPECS.map((spec) => {
    const profile: MachineProfile = {
      kind: spec.kind,
      model: spec.model,
      label: spec.label,
      vendor: spec.vendor,
      os: spec.os,
      osVersion: null,
      arch: spec.arch,
      cpus: null,
      memoryGb: null,
      evidence: spec.evidence
    }
    const workspaces = spec.workspaces.map((w, i) => workspaceFor(rand, spec.id, i, w, now))
    const offline = spec.away !== null
    const levels: LevelsSnapshot | null =
      spec.away === 'never'
        ? null
        : {
            v: 1,
            rev: 1,
            at: offline ? now - (spec.away as number) : now,
            machine: { name: spec.name, appVersion: '0.3.0', profile },
            focusedWorkspaceId: workspaces[0]?.id ?? null,
            workspaces: offline
              ? workspaces.map((w) => ({ ...w, agents: w.agents.map((a) => ({ ...a, phase: 'offline' as const, phaseSource: 'ledger' as const, status: null })) }))
              : workspaces
          }
    return {
      id: spec.id,
      name: spec.name,
      online: !offline,
      lastSeenAt: spec.away === 'never' ? null : offline ? now - (spec.away as number) : now,
      appVersion: '0.3.0',
      profile,
      levels
    }
  })
}
