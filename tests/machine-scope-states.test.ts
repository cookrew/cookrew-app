import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bareWindow } from './support/memory-storage'
import { inConsole, unfoldRelay } from './support/console-scope'

/**
 * EVERYTHING A PAGE HOLDS FOR ONE MACHINE, LET GO OF WHEN ANOTHER IS ENTERED.
 *
 * Each of these was a module-level variable with no key at all, safe while a
 * page had one machine for life. On the console a forgotten one is machine A's
 * agents, drafts or pictures drawn over machine B. So the list is held here,
 * by name: every module that registers with the scope, each with a case that
 * puts something in for A, enters B and looks for it.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'src')

/** Every module that registers per-machine state, and the names it registers. The whole list: see the sweep below. */
const REGISTERED: Record<string, readonly string[]> = {
  'activity-thumb-store.ts': ['agent activity', 'browser thumbs'],
  'api.ts': ['remote api'],
  'attach-view.ts': ['attached item'],
  'auth-gate.ts': ['pairing token store'],
  'cable-signal.ts': ['cable signals'],
  'data-plane.ts': ['data plane'],
  'device-seat.ts': ['device seat'],
  'local-network-gate.ts': ['local network ask'],
  'machine-session.ts': ['machine session'],
  'path-attempts.ts': ['path attempts'],
  'path-link.ts': ['path link'],
  'path/companion.ts': ['path switch memory'],
  'pictures/use-picture.ts': ['pictures'],
  'plane-health.ts': ['plane health'],
  'prompt/input-refused.ts': ['refused input'],
  'prompt/live-line.ts': ['typed lines'],
  'prompt/prompt-draft.ts': ['prompt drafts'],
  'prompt/reply-voice.ts': ['reply voice'],
  'prompt/use-preset-commands.ts': ['preset offers'],
  'prompt/wait-answer.ts': ['menu answers'],
  'remote-api.ts': ['machine api'],
  'rtc-plane.ts': ['rtc link'],
  'stage/stage-select.ts': ['stage selection'],
  // Each card's last tail and its tag (bytes 0.6.2): one machine's, let go of on a change of machine.
  'stream/stream-http.ts': ['stream tails held'],
  'tuning-store.ts': ['agent tuning'],
  'use-cursors.ts': ['use cursors'],
  'use/source-picker-store.ts': ['source picker'],
  'use/unlock-sheet-store.ts': ['unlock sheet'],
  'workspace-arrival.ts': ['workspace arrival'],
  'zoom/bar-pick.ts': ['bar card'],
  'zoom/gauge-store.ts': ['machine gauges'],
  'zoom/remote-machine-store.ts': ['inside another machine'],
  'zoom/simple-fix.ts': ['simple fixes'],
  'zoom/use-zoom-fleet.ts': ['zoom fleet'],
  'zoom/zoom-store.ts': ['zoom focus']
}

/**
 * What stops before anything is cleared: the things that talk (a stream, a
 * loop, a link), and the things that tell listeners when they let go. A
 * listener may ask for the api or the token store; told while those still
 * stand, it gets the ones it always had, not ones made anew for a machine
 * that is being left.
 */
const STOPPED_FIRST = ['data plane', 'machine api', 'machine gauges', 'machine session', 'reply voice', 'rtc link', 'zoom fleet']

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

type Scope = typeof import('../src/renderer/src/machine-scope')
let scope: Scope

beforeEach(async () => {
  vi.resetModules()
  const page = bareWindow('https://console.cookrew.dev/')
  vi.stubGlobal('window', { ...page, COOKREW_MOBILE: 1 })
  vi.stubGlobal('localStorage', page.localStorage)
  vi.stubGlobal('document', { hidden: false, visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined })
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
  scope = await inConsole(A)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the list of what belongs to a machine', () => {
  it('names every module that registers, so none is added or dropped without this list saying so', () => {
    const found = sourceFiles(RENDERER)
      .filter((file) => !file.endsWith('machine-scope.ts') && /registerScopeState\(/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(RENDERER, file).split(path.sep).join('/'))
      .sort()
    expect(found).toEqual(Object.keys(REGISTERED).sort())
  })

  it('is what the scope really holds once those modules are loaded, each under its own name', async () => {
    for (const file of Object.keys(REGISTERED)) await import(`../src/renderer/src/${file.replace(/\.tsx?$/, '')}`)
    expect([...scope.scopeStates()].sort()).toEqual(Object.values(REGISTERED).flat().sort())
  })

  it('stops what talks before it clears what holds', async () => {
    for (const file of Object.keys(REGISTERED)) await import(`../src/renderer/src/${file.replace(/\.tsx?$/, '')}`)
    const phases = scope.scopePhases()
    const stopped = Object.keys(phases).filter((name) => phases[name] === 'stop').sort()
    expect(stopped).toEqual([...STOPPED_FIRST].sort())
    // And in that order when a machine is left, whatever order the modules loaded in.
    const order: string[] = []
    scope.registerScopeState('a late holder', () => order.push('clear'))
    scope.registerScopeState('a late talker', () => order.push('stop'), 'stop')
    scope.enterMachine(B)
    expect(order).toEqual(['stop', 'clear'])
  })

  it('is registered under the one name the sweep looks for: no alias, no wrapper', () => {
    for (const file of sourceFiles(RENDERER)) {
      if (file.endsWith('machine-scope.ts')) continue
      const text = readFileSync(file, 'utf8')
      expect(/registerScopeState\s+as\s/.test(text), file).toBe(false)
      // Used only as a call at module level: never passed on or kept under another name.
      const uses = text.match(/registerScopeState(?!\()/g) ?? []
      const imports = text.match(/import\s*\{[^}]*registerScopeState[^}]*\}\s*from/g) ?? []
      expect(uses.length, file).toBe(imports.length)
    }
  })
})

describe('entering another machine lets go of', () => {
  it('the direct plane, its health and what the last race tried', async () => {
    const plane = await import('../src/renderer/src/data-plane')
    const health = await import('../src/renderer/src/plane-health')
    const attempts = await import('../src/renderer/src/path-attempts')
    plane.setDataPlane({ origin: `https://192-168-2-40.${A}.d.cookrew.dev:8643`, kind: 'lan' })
    attempts.recordAttempts([], 'LAN')
    // Given up on, with a hold: what the last machine's link earned.
    health.planeHealth().suspect('a stream went silent')
    await vi.waitFor(() => expect(health.planeHealth().held()).toBe(true))
    expect(health.planeHealth().lastReason()).not.toBeNull()

    scope.enterMachine(B)
    expect(plane.dataPlane()).toEqual({ origin: '', kind: 'relay' })
    expect(health.planeHealth().held()).toBe(false)
    expect(health.planeHealth().lastReason()).toBeNull()
    expect(attempts.pathAttempts()).toEqual({ attempts: [], settled: 'RELAY' })
  })

  it('the badge’s facts and the ALLOW row’s aim, and tells whoever draws them', async () => {
    const link = await import('../src/renderer/src/path-link')
    const gate = await import('../src/renderer/src/local-network-gate')
    const heard: (string | null)[] = []
    link.subscribePathLink((next) => heard.push(next.desktopName))
    link.setDesktopName('Studio Mac')
    link.recordLatency(42)
    link.setPathLink('failed')
    gate.offerLocalNetwork(async () => undefined)
    expect(gate.localNetworkOffered()).toBe(true)

    scope.enterMachine(B)
    expect(link.pathLinkState()).toEqual({ link: 'live', latencyMs: null, desktopName: null, probing: false })
    expect(heard.at(-1)).toBeNull()
    expect(gate.localNetworkOffered()).toBe(false)
    // Still listening, for the next machine's name.
    link.setDesktopName('Solis')
    expect(heard.at(-1)).toBe('Solis')
  })

  it('every agent’s activity and dials, and every page’s picture, given back to the browser', async () => {
    const stores = await import('../src/renderer/src/activity-thumb-store')
    const tuning = await import('../src/renderer/src/tuning-store')
    const revoked: string[] = []
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(String(url)))
    stores.activityStore.set('t1', { phase: 'thinking' } as never)
    stores.markActivitySeeded()
    stores.thumbStore.set('b1', 'blob:https://console.cookrew.dev/one')
    stores.thumbStore.set('b2', 'data:image/png;base64,AAAA')
    tuning.tuningStore.set('t1', { model: 'x' } as never)

    scope.enterMachine(B)
    expect(stores.activityStore.get('t1')).toBeUndefined()
    expect(stores.isActivitySeeded()).toBe(false)
    expect(stores.thumbStore.get('b1')).toBeUndefined()
    expect(stores.thumbStore.get('b2')).toBeUndefined()
    expect(revoked).toEqual(['blob:https://console.cookrew.dev/one'])
    expect(tuning.tuningStore.get('t1')).toBeUndefined()
  })

  it('what was being typed, answered and offered back, so none of it is sent to the next machine', async () => {
    const drafts = await import('../src/renderer/src/prompt/prompt-draft')
    const lines = await import('../src/renderer/src/prompt/live-line')
    const answers = await import('../src/renderer/src/prompt/wait-answer')
    const refused = await import('../src/renderer/src/prompt/input-refused')
    const told = vi.fn()
    drafts.subscribeDrafts(told)
    drafts.setDraft('agent-1', 'half a thought')
    drafts.setDraft(drafts.draftKey(null), 'start a new agent that')
    lines.typeLine('agent-1', 'half a thought', true)
    lines.holdLines(['agent-2'])
    answers.waitAnswers.set('agent-1', { sig: 's', index: 0, choice: { rows: [] } as never, at: 1 })
    refused.noteSent({ id: 't1', box: 'agent-1', words: 'run it', at: 1000 })
    told.mockClear()

    scope.enterMachine(B)
    expect(drafts.getDraft('agent-1')).toBe('')
    expect(drafts.getDraft(drafts.draftKey(null))).toBe('')
    expect(drafts.draftedAgents()).toEqual([])
    expect(told).toHaveBeenCalled()
    // A line never typed HERE: the same words for an agent of the same id are typed whole,
    // not skipped as already there, and with no backspaces for words of the last machine.
    const typed = (): { url: string; data: string }[] =>
      vi
        .mocked(fetch)
        .mock.calls.map(([url, init]) => [unfoldRelay(String(url), init as RequestInit), init] as const)
        .filter(([url]) => url.includes('/api/terminal/agent-1/raw'))
        .map(([url, init]) => ({ url, data: String(JSON.parse(String((init as RequestInit).body)).data) }))
    const before = typed().length
    lines.typeLine('agent-1', 'half a thought', true)
    expect(typed().slice(before)).toEqual([{ url: `https://api.cookrew.dev/api/m/${B}/api/terminal/agent-1/raw`, data: 'half a thought' }])
    expect(answers.waitAnswers.get('agent-1')).toBeNull()
    expect(refused.takeRefused('t1', '\r', 1001)).toBeNull()
  })

  it('who was in focus, picked or open, and keeps where the person stands in the app', async () => {
    const zoom = await import('../src/renderer/src/zoom/zoom-store')
    const bar = await import('../src/renderer/src/zoom/bar-pick')
    const stage = await import('../src/renderer/src/stage/stage-select')
    const attach = await import('../src/renderer/src/attach-view')
    const picker = await import('../src/renderer/src/use/source-picker-store')
    const unlock = await import('../src/renderer/src/use/unlock-sheet-store')
    const inside = await import('../src/renderer/src/zoom/remote-machine-store')
    zoom.zoomStore.go(1, 'agents')
    zoom.zoomStore.focusAgent('agent-1')
    zoom.zoomStore.focusItem('item-1')
    bar.barCard.open({ kind: 'agent', id: 'agent-1' })
    stage.stageSelect.set({ kind: 'item', id: 'item-1' })
    attach.attachView.open('t1', 'item-1', 'note')
    picker.openSourcePicker({ card: 'card-1' })
    const afterUnlock = vi.fn()
    unlock.openUnlockSheet(afterUnlock)
    inside.remotePlace.enter({ id: B, name: 'Solis', os: 'linux' })
    inside.setRemoteDraft(B, 'agent-9', 'words for a machine, kept by its own id')

    scope.enterMachine(B)
    expect(zoom.zoomStore.get()).toMatchObject({ dir: 'agents', v: 1, agent: null, item: null, full: null })
    expect(bar.barCard.get()).toBeNull()
    expect(stage.stageSelect.get()).toEqual({ kind: 'auto' })
    expect(attach.attachView.get()).toBeNull()
    expect(picker.currentSourceAsk()).toBeNull()
    expect(unlock.unlockSheetOpen()).toBe(false)
    // Closed, not unlocked: what it would have done for the last machine is not done.
    expect(afterUnlock).not.toHaveBeenCalled()
    expect(inside.remotePlace.get().machine).toBeNull()
    // Kept by that machine's own id, whichever machine is in scope.
    expect(inside.remoteDraft(B, 'agent-9')).toBe('words for a machine, kept by its own id')
  })

  it('the hush after a workspace was made here: the next machine’s events are not swallowed by it', async () => {
    const arrival = await import('../src/renderer/src/workspace-arrival')
    arrival.beginArrival(1_000)
    expect(arrival.heldForArrival({ type: 'workspace.created' }, 1_001)).toBe(true)
    scope.enterMachine(B)
    expect(arrival.heldForArrival({ type: 'workspace.created' }, 1_001)).toBe(false)
  })

  it('a fix in progress, the presets asked for and the pictures read', async () => {
    const fixes = await import('../src/renderer/src/zoom/simple-fix')
    void fixes.simpleFixes.press('t1', 'do it', () => new Promise(() => undefined))
    expect(fixes.simpleFixes.get('t1')).not.toBeNull()
    scope.enterMachine(B)
    expect(fixes.simpleFixes.get('t1')).toBeNull()
  })
})
