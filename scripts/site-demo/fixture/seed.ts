/**
 * THE DEMO CAST for the site's illustrations (2026-11-17, with Intro Page). Synthetic and English
 * throughout: no owner workspace, machine, account, path or session stands behind any of it.
 * Built through the demo api's own verbs so the renderer sees one consistent store; only the
 * read-outs no demo has (activity, roster, inbox) are answered here.
 */
import { rankInbox } from '@repo/src/shared/inbox-rank'
import { routeFixture } from '@repo/src/shared/route-fixture'

type Api = Record<string, (...args: any[]) => any>
const now = Date.now()
const ago = (min: number): number => now - min * 60_000

export const RELEASE = 'demo-ws'

const agent = (id: string, name: string, harness: 'claude' | 'codex', orch: boolean, phase: 'thinking' | 'idle', task: string, reply: string | null) =>
  ({ id, name, harness, model: null, orch, phase, phaseSource: 'live', phaseSince: ago(4), task, reply, status: null, turns: 3, attachments: [] })
const GB = 1024 ** 3
/** Fictional load for the two demo machines. */
const GAUGES = {
  studio: () => ({ at: Date.now(), cpuPercent: 23, memory: { usedBytes: 21.4 * GB, totalBytes: 32 * GB, swapUsedBytes: 0, kernelLevel: 1 }, disk: { freeBytes: 412e9, totalBytes: 1e12 }, gpuPercent: 11, gpuAbsent: false }),
  build: () => ({ at: Date.now(), cpuPercent: 64, memory: { usedBytes: 38 * GB, totalBytes: 64 * GB, swapUsedBytes: 0, kernelLevel: null }, disk: { freeBytes: 1.3e12, totalBytes: 2e12 }, gpuPercent: null, gpuAbsent: true })
}
/** Build Server's own answer: one workspace, two agents. */
const BUILD_SERVER = {
  v: 1,
  rev: 1,
  at: now,
  machine: { name: 'Build Server', appVersion: '0.6.15', profile: { kind: 'server', model: null, label: 'Linux server', vendor: null, os: 'linux', osVersion: null, arch: 'x64', cpus: null, memoryGb: null, evidence: [] } },
  focusedWorkspaceId: 'demo-nightly',
  workspaces: [
    {
      id: 'demo-nightly',
      name: 'Nightly Builds',
      icon: null,
      state: 'focused',
      agents: [
        agent('nb-builder', 'Builder', 'codex', true, 'thinking', 'Run the nightly build and the test suite', null),
        agent('nb-triage', 'Triage', 'claude', false, 'idle', 'Sort last night’s failures', 'Two flaky tests, both in the upload path; notes in the issue.')
      ],
      loose: [{ id: 'nb-ci', kind: 'browser', title: 'Nightly CI', host: 'ci.example/nightly', tabs: 1, shared: false }],
      newest: { id: 'nb-ci', kind: 'browser', title: 'Nightly CI', host: 'ci.example/nightly', tabs: 1, shared: false },
      counts: { agents: 2, notes: 0, browsers: 1 }
    }
  ]
}
export let DOCS = ''

const term = (id: string, name: string, preset: string, command: string, x: number, y: number, orch = false) => ({
  kind: 'terminal', id, name, preset, command, cwd: '~/release-room', orch, role: null, position: { x, y }, size: { width: 560, height: 420 }
})

const CHECKLIST = '# release-checklist\n\n- [x] Changelog drafted (Planner)\n- [ ] API diff reviewed (Reviewer)\n- [x] Browser check on the notes page (Checker)\n- [ ] Customer notes summarised (Notes)\n\nShip when every box is ticked.'

function activity(terminalId: string, phase: string, extra: Record<string, unknown> = {}) {
  return {
    terminalId, agent: true, phase, prompt: null, pendingInput: null, lines: [], reply: null, glance: null, title: null,
    turnCount: 3, turnStartLine: null, scrollRow: null, tailLines: null, scrollBase: null, turnStartedAt: ago(2), dispatchId: null, updatedAt: ago(1),
    ...extra
  }
}

export const ACTIVITY = [
  activity('rr-planner', 'waiting', {
    prompt: 'Draft the v1.4 release notes from the merged changes',
    waitSeq: 1,
    waitChoice: {
      kind: 'menu', question: 'Allow this edit to CHANGELOG.md?', sub: 'Edit · CHANGELOG.md · +18 −0', cursor: 0, escIndex: 2,
      options: [
        { key: '1', label: 'Yes', detail: null },
        { key: '2', label: 'Yes, allow all edits during this session', detail: null },
        { key: '3', label: 'No, and tell Claude what to do differently', detail: null }
      ]
    }
  }),
  activity('rr-reviewer', 'thinking', {
    prompt: 'Review the API diff for breaking changes',
    glance: { status: 'Reviewing… (38s)', tools: ['Read src/api/routes.ts', 'Bash git diff v1.3 -- src/api'], message: 'Two routes changed shape; checking the callers.' }
  }),
  activity('rr-checker', 'replied', {
    prompt: 'Open the notes page and check every link',
    reply: 'All 12 links on the release notes page resolve, and the page renders at 390 px without overflow. One image is missing its alt text; I listed it in release-checklist.'
  }),
  activity('rr-notes', 'idle', { prompt: 'Summarise the customer notes', reply: 'Three themes: faster sign-in, clearer errors, and an export button.' }),
  activity('ds-writer', 'waiting', {
    prompt: 'Update the install guide for v1.4',
    waitSeq: 1,
    waitChoice: {
      kind: 'menu', question: 'Which install path should the guide lead with?', sub: null, cursor: 0, escIndex: null,
      options: [
        { key: '1', label: 'The download button', detail: 'Mac app first' },
        { key: '2', label: 'Homebrew', detail: 'one command' }
      ]
    }
  }),
  activity('ds-editor', 'replied', { prompt: 'Proofread the FAQ', reply: 'The FAQ reads cleanly; I fixed two broken anchors.' })
]

export function roster(docs: string) {
  const row = (id: string, name: string, preset: string, workspaceId: string, workspaceName: string, orch = false) => ({
    id, name, preset, role: null, cwd: '~/release-room', workspaceId, workspaceName, spawnedAt: ago(90), orch, active: true, failure: null
  })
  return [
    row('rr-planner', 'Planner', 'Claude Code', RELEASE, 'Release Room', true),
    row('rr-reviewer', 'Reviewer', 'Codex', RELEASE, 'Release Room'),
    row('rr-checker', 'Checker', 'OpenCode', RELEASE, 'Release Room'),
    row('rr-notes', 'Notes', 'Pi', RELEASE, 'Release Room'),
    row('ds-writer', 'Writer', 'Claude Code', docs, 'Docs Site'),
    row('ds-editor', 'Editor', 'Codex', docs, 'Docs Site')
  ]
}

/**
 * The Routing panel's read-out, cleaned for the site: the product's own fixture (route-fixture.ts) carries a
 * maintainer's address, maintainer crew names and group wording the Magpie page ruling dropped. Here: no
 * account email, generic group names, one real local tag (ollama qwen3:32b), the four harnesses ready.
 */
export function cleanRoute() {
  const base = routeFixture('online')
  const group = (id: string, displayName: string) => ({ id, displayName, ownedBy: 'magpie', group: true, reasoning: true, levels: ['low', 'medium', 'high'], contextWindow: null })
  return {
    ...base,
    defaultModel: 'group/default',
    mcpServers: [],
    providers: 3,
    models: [group('group/default', 'default'), group('group/review', 'review'), { id: 'ollama/qwen3:32b', displayName: 'qwen3:32b', ownedBy: 'ollama', group: false, reasoning: false, levels: [], contextWindow: 32_000 }],
    quotas: [
      { provider: 'claude', account: null, alias: 'Claude subscription', plan: null, kind: 'subscription', windows: [], last: false, error: null },
      { provider: 'codex', account: null, alias: 'ChatGPT subscription', plan: null, kind: 'subscription', windows: [{ name: '5 hours', used: 20, limit: 100, resetsAt: null, display: '20 / 100' }], last: false, error: null },
      { provider: 'ollama', account: null, alias: null, plan: null, kind: 'local', windows: [], last: false, error: null }
    ],
    live: [],
    harnesses: base.harnesses.map((h: Record<string, unknown>) => ({ ...h, installed: true, signedIn: true, inDock: true })),
    autoGroup: false,
    setup: { ...base.setup, addGroupLine: 'magpie group add default' }
  }
}

const ROUTES: Record<string, string> = { 'rr-planner': 'group/default', 'rr-reviewer': 'group/review', 'rr-checker': 'group/default', 'rr-notes': 'ollama/qwen3:32b' }

export async function seed(api: Api, options: { page: string }): Promise<void> {
  await api.renameWorkspace(RELEASE, 'Release Room')
  for (const id of ['demo-conductor', 'demo-note', 'demo-browser']) await api.removeNode(id)
  const nodes = [
    term('rr-planner', 'Planner', 'Claude Code', 'claude', 340, 120, true),
    term('rr-reviewer', 'Reviewer', 'Codex', 'codex', 960, 120),
    term('rr-checker', 'Checker', 'OpenCode', 'opencode', 340, 620),
    term('rr-notes', 'Notes', 'Pi', 'pi', 960, 620),
    { kind: 'note', id: 'rr-note', name: 'release-checklist', customName: 'release-checklist', content: CHECKLIST, locked: false, position: { x: 1600, y: 120 }, size: { width: 300, height: 320 } },
    { kind: 'browser', id: 'rr-browser', name: 'Release notes', url: options.page, position: { x: 1600, y: 520 }, size: { width: 560, height: 420 } },
    { kind: 'browser', id: 'rr-screen', name: 'Main display', url: 'screen://main', position: { x: 2240, y: 120 }, size: { width: 720, height: 460 } },
    { kind: 'browser', id: 'rr-phone', name: 'iPhone 17 Pro', url: 'window://Simulator?id=103', position: { x: 2240, y: 640 }, size: { width: 420, height: 720 } }
  ]
  for (const n of nodes) await api.addNode(n)
  for (const [a, b] of [['rr-planner', 'rr-reviewer'], ['rr-planner', 'rr-checker'], ['rr-planner', 'rr-notes'], ['rr-reviewer', 'rr-checker'], ['rr-planner', 'rr-note'], ['rr-checker', 'rr-browser'], ['rr-checker', 'rr-screen'], ['rr-checker', 'rr-phone']]) await api.connectNodes(a, b)

  const docs = await api.createWorkspace('Docs Site', '~/docs-site')
  DOCS = docs.id
  for (const n of [term('ds-writer', 'Writer', 'Claude Code', 'claude', 340, 120, true), term('ds-editor', 'Editor', 'Codex', 'codex', 960, 120)]) await api.addNode(n)
  await api.connectNodes('ds-writer', 'ds-editor')
  await api.switchWorkspace(RELEASE)

  const list = roster(DOCS)
  const profile = (kind: string, os: string, label: string) => ({ kind, model: null, label, vendor: null, os, osVersion: null, arch: 'arm64', cpus: null, memoryGb: null, evidence: [] })
  const machines = {
    ok: true,
    machines: [
      { id: 'demo-studio', name: 'Studio Mac', online: true, lastSeenAt: now, appVersion: '0.6.15', profile: profile('laptop', 'darwin', 'MacBook'), workspaces: [{ id: RELEASE, name: 'Release Room' }, { id: DOCS, name: 'Docs Site' }], current: true },
      { id: 'demo-build', name: 'Build Server', online: true, lastSeenAt: ago(1), appVersion: '0.6.15', profile: profile('server', 'linux', 'Linux server'), workspaces: [{ id: 'demo-nightly', name: 'Nightly Builds' }], current: false }
    ]
  }
  Object.assign(api, {
    routeState: () => Promise.resolve(cleanRoute()),
    terminalRoute: (id: string) =>
      Promise.resolve({ route: ROUTES[id] ?? 'direct', effective: ROUTES[id] ?? null, appliesOn: 'now', live: null, turn: null, offline: false, note: null, gateway: 'online', routable: true }),
    zoomFleetMachines: () => Promise.resolve(machines),
    // The account's second machine, read as a signed-in desktop reads it (its own fleet snapshot), not the no-account page.
    machineFleetOf: (id: string) => Promise.resolve(id === 'demo-build' ? BUILD_SERVER : null),
    // Demo gauges (shared/machine-gauges.ts), so the devices stop shows load rather than "no reading": a Mac with a GPU, a
    // Linux build box without one.
    machineGauges: () => Promise.resolve(GAUGES.studio()),
    machineGaugesOf: (id: string) => Promise.resolve(id === 'demo-build' ? GAUGES.build() : null),
    machineName: () => Promise.resolve('Studio Mac'),
    listActivity: () => Promise.resolve(ACTIVITY),
    onTerminalActivity: () => () => undefined,
    listAgents: () => Promise.resolve(list),
    onAgentRegistry: () => () => undefined,
    onAgentChanged: () => () => undefined,
    onAgentSpawn: () => () => undefined,
    inbox: () =>
      Promise.resolve(
        rankInbox(
          [
            { kind: 'waiting', nodeId: 'rr-planner', nodeName: 'Planner', nodeKind: 'terminal', workspaceId: RELEASE, workspaceName: 'Release Room', reason: 'asks you — "Allow this edit to CHANGELOG.md?"', since: ago(3), served: false, blockedDownstream: 1 },
            { kind: 'waiting', nodeId: 'ds-writer', nodeName: 'Writer', nodeKind: 'terminal', workspaceId: DOCS, workspaceName: 'Docs Site', reason: 'asks you — "Which install path should the guide lead with?"', since: ago(6), served: false, blockedDownstream: 0 }
          ],
          now
        )
      )
  })
}
