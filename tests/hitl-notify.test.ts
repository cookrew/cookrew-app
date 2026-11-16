// DESKTOP NOTIFICATIONS FOR WHAT NEEDS YOU (owner, 2026-11-16; plan
// docs/hitl-cross-workspace-2026-11-15 · v6.2 phase 3). Two moments only, the
// two the chime rings for: an agent waits on you, an agent replied and you have
// not read it, read off the tracker's phases so a mirrorless agent counts too.
// Never while the window has focus, never for a served workspace, never for a
// reply one agent got from another (a dispatch), never the reply's words. One
// notification per agent, the newest, down once answered or read anywhere; a
// burst folds into one that counts until the window takes focus.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMomentTracker } from '../src/main/hitl-moments'
import { BURST_SIZE, BURST_WINDOW_MS, createNotifier, type MomentNote, type NotifierDeps, type ShownNote } from '../src/main/notifier'
import { readNotifyPref, writeNotifyPref } from '../src/main/notify-pref'

const moment = (kind: MomentNote['kind'], id: string, over: Partial<MomentNote> = {}): MomentNote => ({
  kind, agentId: id, name: `Agent ${id}`, workspaceId: 'w1', workspaceName: 'GOAT Team', ...over
})

function harness(over: Partial<NotifierDeps> = {}) {
  const shown: ShownNote[] = []
  /** What stands in the notification centre now, by key. */
  const open = new Set<string>()
  let clock = 0
  const deps: NotifierDeps = {
    show: (note) => {
      shown.push(note)
      open.add(note.key)
      return { close: () => void open.delete(note.key) }
    },
    focused: () => false,
    enabled: () => true,
    served: () => false,
    now: () => clock,
    ...over
  }
  const notifier = createNotifier(deps)
  return { notifier, shown, open, tick: (ms: number) => void (clock += ms) }
}

describe('what a moment shows', () => {
  it('a wait and an unread reply, by name and workspace', () => {
    const h = harness()
    h.notifier.notify(moment('waiting', 'a'))
    h.notifier.notify(moment('reply', 'b'))
    expect(h.shown.map((n) => [n.title, n.body])).toEqual([
      ['Agent a needs you', 'in GOAT Team'],
      ['Agent b replied', 'in GOAT Team']
    ])
  })
  it('where a click goes: the agent and its workspace', () => {
    const h = harness()
    h.notifier.notify(moment('waiting', 'a'))
    expect(h.shown[0]).toMatchObject({ agentId: 'a', workspaceId: 'w1' })
  })
})

describe('when it stays quiet', () => {
  it('while the window has focus: the bar and the chime are there', () => {
    const h = harness({ focused: () => true })
    h.notifier.notify(moment('waiting', 'a'))
    expect(h.shown).toEqual([])
  })
  it('when the owner turned notifications off', () => {
    const h = harness({ enabled: () => false })
    h.notifier.notify(moment('waiting', 'a'))
    expect(h.shown).toEqual([])
  })
  it("for a served (customer's) workspace", () => {
    const h = harness({ served: (ws) => ws === 'door' })
    h.notifier.notify(moment('waiting', 'a', { workspaceId: 'door' }))
    expect(h.shown).toEqual([])
  })
})

describe('one per agent, settled when answered, a burst folds into one', () => {
  it("an agent's newer moment replaces its older notification", () => {
    const h = harness()
    h.notifier.notify(moment('reply', 'a'))
    h.notifier.notify(moment('waiting', 'a'))
    expect([...h.open]).toEqual(['agent:a'])
    expect(h.shown.at(-1)?.title).toBe('Agent a needs you')
  })

  it('answered or read anywhere (the phone too), its notification comes down', () => {
    const h = harness()
    h.notifier.notify(moment('waiting', 'a'))
    h.notifier.settle('a')
    expect([...h.open]).toEqual([])
  })

  it(`past ${BURST_SIZE} agents in a minute, one notification counts them, and only it stands`, () => {
    const h = harness()
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      h.notifier.notify(moment('waiting', id))
      h.tick(1000)
    }
    expect(h.shown.at(-1)?.title).toBe('5 agents need you')
    expect(h.shown.at(-1)?.agentId).toBeNull()
    expect([...h.open]).toEqual(['burst'])
  })

  it('the burst keeps counting until the window takes focus; it never shrinks or splits back into singles', () => {
    const h = harness()
    for (const id of ['a', 'b', 'c', 'd']) h.notifier.notify(moment('waiting', id))
    h.tick(BURST_WINDOW_MS + 1)
    h.notifier.notify(moment('waiting', 'z'))
    expect(h.shown.at(-1)?.title).toBe('5 agents need you')
    expect([...h.open]).toEqual(['burst'])
  })

  it('the same agent again in a burst does not raise the banner again', () => {
    const h = harness()
    for (const id of ['a', 'b', 'c', 'd']) h.notifier.notify(moment('waiting', id))
    const count = h.shown.length
    h.notifier.notify(moment('reply', 'a'))
    expect(h.shown).toHaveLength(count)
  })

  it('focus takes everything down, and the next moments are single again', () => {
    const h = harness()
    for (const id of ['a', 'b', 'c', 'd']) h.notifier.notify(moment('waiting', id))
    h.notifier.clear()
    expect([...h.open]).toEqual([])
    h.notifier.notify(moment('waiting', 'z'))
    expect(h.shown.at(-1)?.title).toBe('Agent z needs you')
  })

  it('a notification that cannot be shown does not stop the next', () => {
    let fail = true
    const show = vi.fn((note: ShownNote) => {
      if (fail) {
        fail = false
        throw new Error('no notification centre')
      }
      return { close: () => undefined, note }
    })
    const h = harness({ show })
    h.notifier.notify(moment('waiting', 'a'))
    h.notifier.notify(moment('waiting', 'b'))
    expect(show).toHaveBeenCalledTimes(2)
  })
})

describe('when a reply is news, read off the phases (every agent, mirrored or not)', () => {
  it('working, then replied: a reply', () => {
    const m = createMomentTracker()
    expect(m.observe('a', 'thinking', false)).toBeNull()
    expect(m.observe('a', 'replied', false)).toBe('reply')
  })
  it('the first sight of an agent says nothing (a boot, a reconnect)', () => {
    const m = createMomentTracker()
    expect(m.observe('a', 'replied', false)).toBeNull()
    expect(m.observe('b', 'waiting', false)).toBeNull()
  })
  it('a reply pushed again is not news again', () => {
    const m = createMomentTracker()
    m.observe('a', 'thinking', false)
    m.observe('a', 'replied', false)
    expect(m.observe('a', 'replied', false)).toBeNull()
  })
  it('a turn another agent asked for is its answer, not the owner\'s news, even if the dispatch closed before the reply', () => {
    const m = createMomentTracker()
    m.observe('a', 'thinking', true)
    m.observe('a', 'thinking', false)
    expect(m.observe('a', 'replied', false)).toBeNull()
    m.observe('a', 'thinking', false)
    expect(m.observe('a', 'replied', false)).toBe('reply')
  })
  it('a wait answered, or a reply read, settles', () => {
    const m = createMomentTracker()
    m.observe('a', 'thinking', false)
    m.observe('a', 'waiting', false)
    expect(m.observe('a', 'thinking', false)).toBe('settled')
    m.observe('a', 'replied', false)
    expect(m.observe('a', 'idle', false)).toBe('settled')
  })
  it('agents are told apart', () => {
    const m = createMomentTracker()
    m.observe('a', 'thinking', false)
    m.observe('b', 'idle', false)
    expect(m.observe('b', 'replied', false)).toBeNull()
    expect(m.observe('a', 'replied', false)).toBe('reply')
  })
})

describe('the on/off switch lives with main, across restarts', () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), 'cookrew-notify-'))
  it('on until turned off', () => {
    expect(readNotifyPref(dir())).toBe(true)
  })
  it('remembers off, and on again', () => {
    const d = dir()
    writeNotifyPref(d, false)
    expect(readNotifyPref(d)).toBe(false)
    writeNotifyPref(d, true)
    expect(readNotifyPref(d)).toBe(true)
  })
  it('a broken file is the default, on', () => {
    const d = dir()
    writeNotifyPref(d, false)
    writeFileSync(path.join(d, 'notifications.json'), '{nope')
    expect(readNotifyPref(d)).toBe(true)
    expect(readFileSync(path.join(d, 'notifications.json'), 'utf8')).toBe('{nope')
  })
})
