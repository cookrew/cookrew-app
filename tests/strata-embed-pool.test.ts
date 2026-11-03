import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShellToEmbed, StrataMachine } from '../src/shared/strata'
import { createEmbedPool, EMBED_TIMEOUTS, FRAME_FADE_MS, isEmbedError, SUPERSEDED, type EmbedDeps, type FrameHandle } from '../src/strata/embed/embed-pool'
import { fromFrame, fromShell, parseEmbedToShell, type MessageLike } from '../src/strata/embed/messages'

const ORIGIN = 'https://cookrew.dev'

const machine = (id: string, link: StrataMachine['link'] = 'live'): StrataMachine => ({
  id,
  name: id,
  online: link !== 'offline',
  lastSeenAt: 0,
  appVersion: '0.4.0',
  profile: null,
  base: `/relay/@me/desktop/${id}/`,
  link,
  levels: null,
  stale: false
})

interface FakeFrame extends FrameHandle {
  machineId: string
  src: string
  visible: boolean
  removed: boolean
  inbox: ShellToEmbed[]
  window: { name: string }
  load(page: boolean): void
}

const harness = (opts: { machines?: StrataMachine[]; maxWarm?: number; onHost?: (el: HTMLElement) => void } = {}) => {
  const machines = new Map((opts.machines ?? [machine('a'), machine('b'), machine('c'), machine('d')]).map((m) => [m.id, m]))
  const frames: FakeFrame[] = []
  let deliver: (event: MessageLike) => void = () => {}
  const out = vi.fn()
  const deps: EmbedDeps = {
    origin: ORIGIN,
    host: opts.onHost,
    createFrame: (machineId, src, onLoad) => {
      const frame: FakeFrame = {
        machineId,
        src,
        load: (page) => onLoad({ page }),
        visible: true,
        removed: false,
        inbox: [],
        window: { name: `win-${machineId}-${frames.length}` },
        show: () => void (frame.visible = true),
        hide: () => void (frame.visible = false),
        remove: () => void (frame.removed = true)
      }
      frames.push(frame)
      return frame
    },
    post: (frame, message) => void (frame as FakeFrame).inbox.push(message),
    listen: (run) => {
      deliver = run
      return () => (deliver = () => {})
    },
    machine: (id) => machines.get(id),
    embedUrl: (m, agentId) => `${m.base}?embed=agent${agentId ? `&agent=${encodeURIComponent(agentId)}` : ''}`,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    maxWarm: () => opts.maxWarm ?? 3,
    onOut: out
  }
  const pool = createEmbedPool(deps)
  const live = (id: string) => frames.filter((f) => f.machineId === id && !f.removed)
  const frameOf = (id: string) => {
    const [frame] = live(id)
    if (!frame) throw new Error(`no frame for ${id}`)
    return frame
  }
  const say = (id: string, data: unknown, overrides: Partial<MessageLike> = {}) =>
    deliver({ origin: ORIGIN, source: frameOf(id).window, data, ...overrides })
  return { pool, frames, live, frameOf, say, out, machines }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
})
afterEach(() => vi.useRealTimers())

describe('the embed pool: a cold dive', () => {
  it('creates the machine’s document with the agent in its URL and shows it on ready', async () => {
    const h = harness()
    const opened = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    expect(h.frameOf('a').src).toBe('/relay/@me/desktop/a/?embed=agent&agent=x')
    expect(h.frameOf('a').visible).toBe(false)
    vi.advanceTimersByTime(900)
    h.say('a', { type: 'strata:ready', agentId: 'x' })
    await opened
    expect(h.frameOf('a').visible).toBe(true)
    expect(h.pool.getSnapshot().shown).toEqual({ machineId: 'a', agentId: 'x' })
    expect(h.pool.getSnapshot().lastDive).toEqual({ machineId: 'a', agentId: 'x', warm: false, ms: 900 })
  })

  it('never puts a token in the URL it loads', () => {
    const h = harness()
    void h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' }).catch(() => {})
    expect(h.frameOf('a').src).not.toMatch(/token|pair=/)
  })

  it('times a cold boot out, drops the document, and a retry starts over', async () => {
    const h = harness()
    const opened = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    vi.advanceTimersByTime(EMBED_TIMEOUTS.coldMs)
    await expect(opened).rejects.toMatchObject({ code: 'unreachable', detail: 'timeout' })
    expect(h.live('a')).toHaveLength(0)
    expect(h.pool.getSnapshot().failed).toMatchObject({ machineId: 'a', code: 'unreachable' })
    void h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    expect(h.live('a')).toHaveLength(1)
  })

  it('fails fast when the frame loads a refusal instead of a page', async () => {
    const h = harness()
    const opened = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    const frame = h.frameOf('a')
    frame.load(false)
    await expect(opened).rejects.toMatchObject({ code: 'unreachable', detail: 'refused' })
    expect(frame.removed).toBe(true)
  })

  it('refuses at once for a machine that cannot embed', async () => {
    const h = harness({ machines: [machine('u', 'unpaired'), machine('o', 'offline'), machine('old', 'outdated')] })
    await expect(h.pool.open({ machine: 'u', workspace: 'w', agent: 'x' })).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(h.pool.open({ machine: 'o', workspace: 'w', agent: 'x' })).rejects.toMatchObject({ code: 'offline' })
    await expect(h.pool.open({ machine: 'old', workspace: 'w', agent: 'x' })).rejects.toMatchObject({ code: 'unreachable', detail: 'outdated' })
    await expect(h.pool.open({ machine: 'nope', workspace: 'w', agent: 'x' })).rejects.toMatchObject({ code: 'not-found' })
    expect(h.frames).toHaveLength(0)
  })

  it('passes the embed’s own error through, keeping a healthy document on not-found', async () => {
    const h = harness()
    const opened = h.pool.open({ machine: 'a', workspace: 'w', agent: 'gone' })
    h.say('a', { type: 'strata:error', code: 'not-found', detail: 'agent' })
    await expect(opened).rejects.toMatchObject({ code: 'not-found' })
    expect(h.live('a')).toHaveLength(1)
    const again = h.pool.open({ machine: 'b', workspace: 'w', agent: 'y' })
    h.say('b', { type: 'strata:error', code: 'unauthorized' })
    await expect(again).rejects.toSatisfy(isEmbedError)
    expect(h.live('b')).toHaveLength(0)
  })
})

describe('the embed pool: warm documents', () => {
  it('prewarms with no agent, then a dive is one focus, no reload', async () => {
    const h = harness()
    h.pool.prewarm('a')
    expect(h.frameOf('a').src).toBe('/relay/@me/desktop/a/?embed=agent')
    h.say('a', { type: 'strata:warm' })
    const opened = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' }, 'att-1')
    expect(h.frameOf('a').inbox).toEqual([{ type: 'strata:focus', agentId: 'x', attachmentId: 'att-1' }])
    vi.advanceTimersByTime(120)
    h.say('a', { type: 'strata:ready', agentId: 'x' })
    await opened
    expect(h.frames).toHaveLength(1)
    expect(h.pool.getSnapshot().lastDive).toMatchObject({ warm: true, ms: 120 })
  })

  it('holds a focus until a still-booting prewarm says it is listening', async () => {
    const h = harness()
    h.pool.prewarm('a')
    const opened = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    expect(h.frameOf('a').inbox).toEqual([])
    h.say('a', { type: 'strata:warm' })
    expect(h.frameOf('a').inbox).toEqual([{ type: 'strata:focus', agentId: 'x' }])
    h.say('a', { type: 'strata:ready', agentId: 'x' })
    await opened
  })

  it('switches agents within a machine with a focus, and blurs a machine it leaves', async () => {
    const h = harness()
    const first = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    h.say('a', { type: 'strata:ready', agentId: 'x' })
    await first
    const second = h.pool.open({ machine: 'a', workspace: 'w', agent: 'y' })
    expect(h.frameOf('a').inbox.at(-1)).toEqual({ type: 'strata:focus', agentId: 'y' })
    h.say('a', { type: 'strata:ready', agentId: 'y' })
    await second
    const third = h.pool.open({ machine: 'b', workspace: 'w', agent: 'z' })
    expect(h.frameOf('a').visible).toBe(false)
    vi.advanceTimersByTime(FRAME_FADE_MS)
    expect(h.frameOf('a').inbox.at(-1)).toEqual({ type: 'strata:blur' })
    h.say('b', { type: 'strata:ready', agentId: 'z' })
    await third
    expect(h.frames.filter((f) => f.visible).map((f) => f.machineId)).toEqual(['b'])
  })

  it('re-points a document that booted for an earlier agent', async () => {
    const h = harness()
    const first = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    const second = h.pool.open({ machine: 'a', workspace: 'w', agent: 'y' })
    await expect(first).rejects.toMatchObject({ detail: SUPERSEDED })
    h.say('a', { type: 'strata:ready', agentId: 'x' })
    expect(h.frameOf('a').inbox).toEqual([{ type: 'strata:focus', agentId: 'y' }])
    h.say('a', { type: 'strata:ready', agentId: 'y' })
    await second
    expect(h.pool.getSnapshot().failed).toBeNull()
  })

  it('keeps at most maxWarm documents, dropping the least recently used off-screen one', async () => {
    const h = harness({ maxWarm: 2 })
    h.pool.prewarm('a')
    vi.advanceTimersByTime(10)
    h.pool.prewarm('b')
    vi.advanceTimersByTime(10)
    h.pool.prewarm('a')
    h.pool.prewarm('c')
    expect(h.live('b')).toHaveLength(0)
    expect(h.live('a')).toHaveLength(1)
    expect(h.live('c')).toHaveLength(1)
  })

  it('never evicts the document on screen', async () => {
    const h = harness({ maxWarm: 2 })
    const shown = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    h.say('a', { type: 'strata:ready', agentId: 'x' })
    await shown
    h.pool.prewarm('b')
    h.pool.prewarm('c')
    expect(h.live('a')).toHaveLength(1)
    expect(h.live('b')).toHaveLength(0)
  })

  it('does not prewarm a machine whose levels are not live', () => {
    const h = harness({ machines: [machine('u', 'unpaired'), machine('c', 'connecting')] })
    h.pool.prewarm('u')
    h.pool.prewarm('c')
    expect(h.frames).toHaveLength(0)
  })

  it('close blurs and hides but keeps the document; trim drops the off-screen ones', async () => {
    const h = harness()
    const shown = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    h.say('a', { type: 'strata:ready', agentId: 'x' })
    await shown
    h.pool.prewarm('b')
    h.pool.close()
    expect(h.frameOf('a').visible).toBe(false)
    // The way out fades first: the terminal stays mounted until the fade is over.
    expect(h.frameOf('a').inbox).toEqual([])
    vi.advanceTimersByTime(FRAME_FADE_MS)
    expect(h.frameOf('a').inbox.at(-1)).toEqual({ type: 'strata:blur' })
    expect(h.pool.getSnapshot().shown).toBeNull()
    h.pool.trim()
    expect(h.live('a')).toHaveLength(0)
    expect(h.live('b')).toHaveLength(0)
  })
})

describe('the embed pool: the seam', () => {
  it('state() is the same object until shown, opening or failed change', async () => {
    const h = harness()
    const idle = h.pool.state()
    h.pool.prewarm('a')
    expect(h.pool.state()).toBe(idle)
    const opened = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    const opening = h.pool.state()
    expect(opening).not.toBe(idle)
    expect(opening).toEqual({ shown: null, opening: { machineId: 'a', agentId: 'x' }, failed: null })
    h.say('a', { type: 'strata:warm' })
    expect(h.pool.state()).toBe(opening)
    h.say('a', { type: 'strata:ready', agentId: 'x' })
    await opened
    expect(h.pool.state()).toEqual({ shown: { machineId: 'a', agentId: 'x' }, opening: null, failed: null })
    const shown = h.pool.state()
    h.pool.prewarm('b')
    expect(h.pool.state()).toBe(shown)
  })

  it('prefetch goes only to a document that is up, once per agent, never for the one on screen', async () => {
    const h = harness()
    h.pool.prefetch({ machine: 'a', workspace: 'w', agent: 'x' })
    expect(h.frames).toHaveLength(0)
    h.pool.prewarm('a')
    h.pool.prefetch({ machine: 'a', workspace: 'w', agent: 'x' })
    expect(h.frameOf('a').inbox).toEqual([])
    h.say('a', { type: 'strata:warm' })
    h.pool.prefetch({ machine: 'a', workspace: 'w', agent: 'x' })
    h.pool.prefetch({ machine: 'a', workspace: 'w', agent: 'x' })
    h.pool.prefetch({ machine: 'a', workspace: 'w', agent: 'y' })
    expect(h.frameOf('a').inbox).toEqual([
      { type: 'strata:prefetch', agentId: 'x' },
      { type: 'strata:prefetch', agentId: 'y' }
    ])
    const opened = h.pool.open({ machine: 'a', workspace: 'w', agent: 'y' })
    h.say('a', { type: 'strata:ready', agentId: 'y' })
    await opened
    h.pool.prefetch({ machine: 'a', workspace: 'w', agent: 'y' })
    expect(h.frameOf('a').inbox.at(-1)).toEqual({ type: 'strata:focus', agentId: 'y' })
  })

  it('a reopen inside the fade-out cancels the blur, so the terminal never unmounts', async () => {
    const h = harness()
    const first = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    h.say('a', { type: 'strata:ready', agentId: 'x' })
    await first
    h.pool.close()
    vi.advanceTimersByTime(FRAME_FADE_MS / 2)
    const again = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    h.say('a', { type: 'strata:ready', agentId: 'x' })
    await again
    vi.advanceTimersByTime(FRAME_FADE_MS * 2)
    expect(h.frameOf('a').inbox.some((m) => m.type === 'strata:blur')).toBe(false)
    expect(h.frameOf('a').visible).toBe(true)
  })

  it('takes its host once, before any frame', () => {
    const hosts: unknown[] = []
    const h = harness({ onHost: (el) => hosts.push(el) })
    const el = { id: 'stage' } as unknown as HTMLElement
    h.pool.host(el)
    h.pool.host({ id: 'other' } as unknown as HTMLElement)
    expect(hosts).toEqual([el])
  })
})

describe('the embed pool: who may speak', () => {
  it('steps out only for strata:out from the frame on screen', async () => {
    const h = harness()
    h.pool.prewarm('b')
    const shown = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    h.say('a', { type: 'strata:ready', agentId: 'x' })
    await shown
    h.say('b', { type: 'strata:out' })
    expect(h.out).not.toHaveBeenCalled()
    h.say('a', { type: 'strata:out' })
    expect(h.out).toHaveBeenCalledTimes(1)
  })

  it('ignores a foreign origin, a foreign window and a malformed message', async () => {
    const h = harness()
    const opened = h.pool.open({ machine: 'a', workspace: 'w', agent: 'x' })
    h.say('a', { type: 'strata:ready', agentId: 'x' }, { origin: 'https://evil.example' })
    h.say('a', { type: 'strata:ready', agentId: 'x' }, { source: { name: 'someone-else' } })
    h.say('a', { type: 'strata:ready', agentId: 42 })
    h.say('a', 'strata:ready')
    expect(h.pool.getSnapshot().shown).toBeNull()
    h.say('a', { type: 'strata:ready', agentId: 'x' })
    await opened
  })
})

describe('message checks', () => {
  const parent = { name: 'parent' }
  const self = { name: 'self' }

  it('the embed believes only its parent on its own origin', () => {
    const focus = { type: 'strata:focus', agentId: 'x' }
    expect(fromShell({ origin: ORIGIN, source: parent, data: focus }, ORIGIN, parent, self)).toEqual(focus)
    expect(fromShell({ origin: 'https://evil.example', source: parent, data: focus }, ORIGIN, parent, self)).toBeNull()
    expect(fromShell({ origin: ORIGIN, source: self, data: focus }, ORIGIN, parent, self)).toBeNull()
    expect(fromShell({ origin: ORIGIN, source: self, data: focus }, ORIGIN, self, self)).toBeNull()
    expect(fromShell({ origin: ORIGIN, source: parent, data: { type: 'strata:focus', agentId: '' } }, ORIGIN, parent, self)).toBeNull()
  })

  it('the shell believes only the frame’s window', () => {
    const ready = { type: 'strata:ready', agentId: 'x' }
    expect(fromFrame({ origin: ORIGIN, source: self, data: ready }, ORIGIN, self)).toEqual(ready)
    expect(fromFrame({ origin: ORIGIN, source: self, data: ready }, ORIGIN, null)).toBeNull()
    expect(parseEmbedToShell({ type: 'strata:error', code: 'boom' })).toBeNull()
    expect(parseEmbedToShell({ type: 'strata:ready', agentId: '' })).toBeNull()
    expect(parseEmbedToShell({ type: 'strata:warm' })).toEqual({ type: 'strata:warm' })
    expect(parseEmbedToShell({ type: 'strata:error', code: 'offline', detail: 'x'.repeat(500) })).toMatchObject({ detail: 'x'.repeat(200) })
  })
})
