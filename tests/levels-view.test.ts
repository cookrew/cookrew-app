import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLevelsHolds, LEVELS_EVENT_CHANNEL, type LevelsSender } from '../src/main/levels/holds'
import type { LevelsService } from '../src/main/levels/service'
import type { LevelsEvent, LevelsSnapshot } from '../src/shared/strata'
import { syntheticFleet } from '../src/strata/fixture/synthetic'
import { keyIntent } from '../src/strata/input/keys'
import type { AnchorRegistry } from '../src/strata/stage/anchors'
import { focusAfterLanding } from '../src/strata/stage/focus'
import { existing, HOME_PATH, readPath } from '../src/renderer/src/levels/levels-history'
import { createLocalFleet, LOCAL_MACHINE_ID, localMachine } from '../src/renderer/src/levels/local-fleet'

/**
 * The desktop levels view (machines → workspaces → agents in the window):
 * the per-window hold on the levels service, the window's one-machine feed,
 * its remembered path, and ⌘K left to the app's command box.
 */

const snapshot = (rev = 1): LevelsSnapshot => {
  const levels = syntheticFleet(1_800_000_000_000).find((m) => m.levels !== null)?.levels
  if (!levels) throw new Error('the synthetic fleet has no machine with levels')
  return { ...levels, rev }
}

function sender(id: number) {
  const events = new EventEmitter()
  const sent: LevelsEvent[] = []
  let destroyed = false
  const s: LevelsSender = {
    id,
    isDestroyed: () => destroyed,
    send: (channel, payload) => {
      if (channel === LEVELS_EVENT_CHANNEL) sent.push(payload)
    },
    on: (event, listener) => events.on(event, listener),
    removeListener: (event, listener) => events.removeListener(event, listener)
  }
  return {
    sender: s,
    sent,
    emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
    listeners: () => events.eventNames().reduce((n, e) => n + events.listenerCount(e), 0),
    destroy: () => {
      destroyed = true
      events.emit('destroyed')
    }
  }
}

/** A service whose subscribe sends a snapshot at once, like the real one, and counts open streams. */
function fakeService() {
  const open = new Set<(event: LevelsEvent) => void>()
  const service = {
    subscribe: (send: (event: LevelsEvent) => void) => {
      open.add(send)
      send({ type: 'snapshot', snapshot: snapshot() })
      return () => void open.delete(send)
    }
  } as unknown as LevelsService
  return { service, open, push: (event: LevelsEvent) => open.forEach((send) => send(event)) }
}

describe('levels holds (main)', () => {
  it('answers false with no service wired', () => {
    const holds = createLevelsHolds(() => null)
    expect(holds.subscribe(sender(1).sender)).toBe(false)
    expect(holds.count()).toBe(0)
  })

  it('pushes a snapshot first, then every delta, to the subscribing window', () => {
    const fake = fakeService()
    const holds = createLevelsHolds(() => fake.service)
    const a = sender(1)
    expect(holds.subscribe(a.sender)).toBe(true)
    fake.push({ type: 'focus', rev: 2, workspaceId: null })
    expect(a.sent.map((e) => e.type)).toEqual(['snapshot', 'focus'])
  })

  it('gives a second subscriber in the same window a fresh snapshot over ONE stream', () => {
    const fake = fakeService()
    const holds = createLevelsHolds(() => fake.service)
    const a = sender(1)
    holds.subscribe(a.sender)
    holds.subscribe(a.sender)
    expect(fake.open.size).toBe(1)
    expect(a.sent.map((e) => e.type)).toEqual(['snapshot', 'snapshot'])
    holds.unsubscribe(a.sender)
    expect(fake.open.size).toBe(1)
    holds.unsubscribe(a.sender)
    expect(fake.open.size).toBe(0)
    expect(holds.count()).toBe(0)
    expect(a.listeners()).toBe(0)
  })

  it('refuses a stream that cannot open, and keeps the window its old one', () => {
    const fake = fakeService()
    let broken = false
    const service = {
      subscribe: (send: (event: LevelsEvent) => void) => {
        if (broken) throw new Error('cold build failed')
        return fake.service.subscribe(send)
      }
    } as unknown as LevelsService
    const holds = createLevelsHolds(() => service)
    const a = sender(1)
    expect(holds.subscribe(a.sender)).toBe(true)
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    broken = true
    expect(holds.subscribe(a.sender)).toBe(false)
    expect(fake.open.size).toBe(1)
    expect(holds.subscribe(sender(2).sender)).toBe(false)
    expect(holds.count()).toBe(1)
    // Only the one hold that was taken is given back.
    holds.unsubscribe(a.sender)
    expect(fake.open.size).toBe(0)
    expect(quiet).toHaveBeenCalledTimes(2)
    quiet.mockRestore()
  })

  it('releases when the page goes, but not for an iframe or same-document navigation', () => {
    const fake = fakeService()
    const holds = createLevelsHolds(() => fake.service)
    const a = sender(1)
    holds.subscribe(a.sender)
    a.emit('did-start-navigation', { isMainFrame: false })
    a.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(holds.count()).toBe(1)
    a.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(holds.count()).toBe(0)
    expect(fake.open.size).toBe(0)
  })

  it('releases when the webContents is destroyed and sends nothing after', () => {
    const fake = fakeService()
    const holds = createLevelsHolds(() => fake.service)
    const a = sender(1)
    holds.subscribe(a.sender)
    a.destroy()
    expect(holds.count()).toBe(0)
    expect(fake.open.size).toBe(0)
    expect(holds.unsubscribe(a.sender)).toBe(false)
  })
})

describe('the window feed (renderer)', () => {
  afterEach(() => vi.useRealTimers())

  const feed = () => {
    const subs: Array<{ cb: (event: LevelsEvent) => void; closed: boolean }> = []
    const subscribe = (cb: (event: LevelsEvent) => void) => {
      const sub = { cb, closed: false }
      subs.push(sub)
      return () => {
        sub.closed = true
      }
    }
    return { subs, subscribe, last: () => subs[subs.length - 1] }
  }

  it('is one connecting machine until the snapshot lands, then live with its levels', () => {
    const f = feed()
    const fleet = createLocalFleet(() => f.subscribe)
    const off = fleet.subscribe(() => undefined)
    expect(fleet.fleet()).toEqual([localMachine(null, 'connecting')])
    expect(fleet.loaded()).toBe(false)
    const levels = snapshot(4)
    f.last().cb({ type: 'snapshot', snapshot: levels })
    const [machine] = fleet.fleet()
    expect(machine.id).toBe(LOCAL_MACHINE_ID)
    expect(machine.link).toBe('live')
    expect(machine.levels).toBe(levels)
    expect(machine.name).toBe(levels.machine.name)
    expect(fleet.loaded()).toBe(true)
    off()
  })

  it('folds deltas, and keeps the same rows when nothing changed', () => {
    const f = feed()
    const fleet = createLocalFleet(() => f.subscribe)
    fleet.subscribe(() => undefined)
    f.last().cb({ type: 'snapshot', snapshot: snapshot(1) })
    const before = fleet.fleet()
    expect(fleet.fleet()).toBe(before)
    f.last().cb({ type: 'focus', rev: 2, workspaceId: null })
    expect(fleet.fleet()).not.toBe(before)
    expect(fleet.fleet()[0].levels?.rev).toBe(2)
    expect(fleet.fleet()[0].levels?.focusedWorkspaceId).toBeNull()
  })

  it('reopens on a gap, so the next thing it folds is a fresh snapshot', () => {
    const f = feed()
    const fleet = createLocalFleet(() => f.subscribe)
    fleet.subscribe(() => undefined)
    f.last().cb({ type: 'snapshot', snapshot: snapshot(1) })
    f.last().cb({ type: 'focus', rev: 5, workspaceId: null })
    expect(f.subs).toHaveLength(2)
    expect(f.subs[0].closed).toBe(true)
    expect(f.subs[1].closed).toBe(false)
  })

  it('says outdated, and loaded, when this api has no levels feed', () => {
    const fleet = createLocalFleet(() => undefined)
    fleet.subscribe(() => undefined)
    expect(fleet.fleet()[0].link).toBe('outdated')
    expect(fleet.loaded()).toBe(true)
  })

  it('counts as loaded after the grace even when the feed never answers', () => {
    vi.useFakeTimers()
    const f = feed()
    const fleet = createLocalFleet(() => f.subscribe, 100)
    fleet.subscribe(() => undefined)
    expect(fleet.loaded()).toBe(false)
    vi.advanceTimersByTime(100)
    expect(fleet.loaded()).toBe(true)
  })

  it('closes the feed while the window is out of sight, and reopens it in sight', () => {
    const f = feed()
    let hidden = true
    let changed: () => void = () => undefined
    const sight = { hidden: () => hidden, watch: (cb: () => void) => ((changed = cb), () => undefined) }
    const fleet = createLocalFleet(() => f.subscribe, 100, sight)
    fleet.subscribe(() => undefined)
    expect(f.subs).toHaveLength(0)
    hidden = false
    changed()
    expect(f.subs).toHaveLength(1)
    f.last().cb({ type: 'snapshot', snapshot: snapshot(1) })
    hidden = true
    changed()
    expect(f.last().closed).toBe(true)
    // The last levels stay on screen for the moment the window is back.
    expect(fleet.fleet()[0].levels?.rev).toBe(1)
    hidden = false
    changed()
    expect(f.subs).toHaveLength(2)
    expect(f.last().closed).toBe(false)
  })

  it('closes the feed a moment after the last reader, not at once', () => {
    vi.useFakeTimers()
    const f = feed()
    const fleet = createLocalFleet(() => f.subscribe)
    const off = fleet.subscribe(() => undefined)
    off()
    expect(f.last().closed).toBe(false)
    fleet.subscribe(() => undefined)
    vi.advanceTimersByTime(5_000)
    expect(f.subs).toHaveLength(1)
    expect(f.last().closed).toBe(false)
  })
})

describe('the remembered path (renderer)', () => {
  it('reads only a well-formed chain of ids', () => {
    expect(readPath(null)).toBeNull()
    expect(readPath('not json')).toBeNull()
    expect(readPath('{"machine":3}')).toBeNull()
    expect(readPath('{"workspace":"w"}')).toBeNull()
    expect(readPath('{"machine":"m","agent":"a"}')).toBeNull()
    expect(readPath('{"machine":"m","workspace":"w","agent":"a","x":1}')).toEqual({ machine: 'm', workspace: 'w', agent: 'a' })
    expect(readPath('{}')).toEqual({})
  })

  it('opens on this desktop when nothing is remembered', () => {
    expect(HOME_PATH).toEqual({ machine: LOCAL_MACHINE_ID })
  })

  it('lands a remembered path whose items have gone on the nearest level that exists', () => {
    const levels = snapshot()
    const live = [localMachine(levels, 'live')]
    const ws = levels.workspaces.find((w) => w.agents.length > 0)
    if (!ws) throw new Error('the synthetic machine has no seated workspace')
    const agent = ws.agents[0].id
    expect(existing({ machine: LOCAL_MACHINE_ID, workspace: ws.id, agent }, live)).toEqual({ machine: LOCAL_MACHINE_ID, workspace: ws.id, agent })
    expect(existing({ machine: LOCAL_MACHINE_ID, workspace: ws.id, agent: 'gone' }, live)).toEqual({ machine: LOCAL_MACHINE_ID, workspace: ws.id })
    expect(existing({ machine: LOCAL_MACHINE_ID, workspace: 'gone', agent }, live)).toEqual({ machine: LOCAL_MACHINE_ID })
    expect(existing({ machine: 'elsewhere' }, live)).toEqual({})
    // Still connecting: the benefit of the doubt.
    const connecting = [localMachine(null, 'connecting')]
    expect(existing({ machine: LOCAL_MACHINE_ID, workspace: 'w', agent: 'a' }, connecting)).toEqual({ machine: LOCAL_MACHINE_ID, workspace: 'w', agent: 'a' })
  })
})

describe('⌘K in a host that owns it', () => {
  const ctx = { level: 'workspaces' as const, typing: false, overlayOpen: false, onControl: false }

  it('stays the finder where the shell owns the page', () => {
    expect(keyIntent({ key: 'k', metaKey: true }, ctx)).toEqual({ type: 'finder' })
  })

  it('is left to the host, while / still opens the finder', () => {
    expect(keyIntent({ key: 'k', metaKey: true }, { ...ctx, modK: false })).toBeNull()
    expect(keyIntent({ key: 'k', ctrlKey: true }, { ...ctx, modK: false })).toBeNull()
    expect(keyIntent({ key: '/' }, { ...ctx, modK: false })).toEqual({ type: 'finder' })
  })
})

describe('the shell sheet inside the app', () => {
  // Rule selectors at any depth (inside @media too); keyframe steps are not selectors.
  const selectors = (css: string): string[] =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1].trim())
      .filter((sel) => !sel.startsWith('@') && !/^(from|to|[\d.]+%)(\s*,\s*(from|to|[\d.]+%))*$/.test(sel))
      .flatMap((sel) => sel.split(',').map((one) => one.trim()))

  it('sets nothing on the page or on bare elements, so the app around the shell is untouched', () => {
    for (const file of ['src/strata/levels/strata.css', 'src/strata/stage/stage.css']) {
      const leaks = selectors(readFileSync(file, 'utf8')).filter((sel) => /^(:root|html|body|\*)(?![\w-])/.test(sel) || /^[a-z][a-z0-9]*(?![\w-])/.test(sel))
      expect(leaks, file).toEqual([])
    }
  })

  it('stays light inside the app, which has no dark theme, whatever the system says', () => {
    // Every dark rule must step aside for a shell the host pinned light.
    const css = readFileSync('src/strata/levels/strata.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const dark = [...css.matchAll(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/g)].flatMap((m) => selectors(m[1]))
    expect(dark.length).toBeGreaterThan(0)
    for (const sel of dark) expect(sel).toContain(":not([data-scheme='light'])")
    expect(readFileSync('src/renderer/src/levels/LevelsView.tsx', 'utf8')).toMatch(/<StrataShell[\s\S]*?scheme="light"/)
  })
})

describe('landing on a host terminal', () => {
  afterEach(() => vi.unstubAllGlobals())

  // No jsdom: just enough of an element for the landing's focus rule.
  class FakeEl {
    focused = 0
    isConnected = true
    constructor(readonly kids: FakeEl[] = []) {}
    contains(other: unknown): boolean {
      return other === this || this.kids.some((kid) => kid.contains(other))
    }
    closest(): null {
      return null
    }
    querySelector(): FakeEl | null {
      return this.kids[0] ?? null
    }
    focus(): void {
      this.focused += 1
    }
  }

  const scene = () => {
    const button = new FakeEl()
    const textarea = new FakeEl()
    const terminal = new FakeEl([button, textarea])
    const sceneEl = new FakeEl([terminal])
    const root = new FakeEl([sceneEl])
    const registry = { get: (id: string) => (id === 'terminal' ? terminal : undefined), set: () => undefined, drop: () => undefined }
    const land = () =>
      focusAfterLanding(
        root as unknown as HTMLElement,
        sceneEl as unknown as HTMLElement,
        registry as unknown as AnchorRegistry,
        { machine: 'm', workspace: 'w', agent: 'a' },
        null
      )
    return { button, textarea, land }
  }

  it('leaves the keys in a terminal that already took focus', () => {
    const { button, textarea, land } = scene()
    vi.stubGlobal('HTMLElement', FakeEl)
    vi.stubGlobal('document', { activeElement: textarea, body: {} })
    land()
    expect(button.focused).toBe(0)
  })

  it('still focuses into the terminal when nothing there has focus yet', () => {
    const { button, land } = scene()
    const body = {}
    vi.stubGlobal('HTMLElement', FakeEl)
    vi.stubGlobal('document', { activeElement: body, body })
    land()
    expect(button.focused).toBe(1)
  })
})
