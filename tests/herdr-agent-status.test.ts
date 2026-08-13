import { describe, expect, it } from 'vitest'
import {
  type FeedPane,
  HerdrStatusFeed,
  panesFrom,
  parseStatusEvent,
  socketPathFor,
  type StatusSocket
} from '../src/main/herdr-agent-status'

/**
 * This feed replaces a scraped signal with a pushed one, so the tests that
 * matter most are about what it says when it does NOT know. A wrong "idle"
 * ends a turn early and mints a checkpoint from a half-finished reply.
 */

const EVENT = (paneId: string, status: string): string =>
  JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: paneId, agent_status: status } })

/** A socket whose incoming data the test drives by hand. */
function fakeSocket(): StatusSocket & { emit: (s: string) => void; written: string[]; close: () => void } {
  const handlers: Record<string, ((chunk: string) => void)[]> = {}
  const written: string[] = []
  return {
    written,
    on(event: string, cb: (chunk: string) => void) {
      ;(handlers[event] ??= []).push(cb)
    },
    write(line: string) {
      written.push(line)
    },
    end() {},
    emit(chunk: string) {
      for (const cb of handlers.data ?? []) cb(chunk)
    },
    close() {
      for (const cb of handlers.close ?? []) cb('')
    }
  } as never
}

function feedWith(
  panes: FeedPane[]
): { feed: HerdrStatusFeed; socket: ReturnType<typeof fakeSocket> } {
  const socket = fakeSocket()
  const feed = new HerdrStatusFeed({
    session: 'cookrew',
    configPath: '/c',
    listPanes: () => panes,
    resolveSocketPath: () => '/tmp/h.sock',
    connect: () => socket
  })
  feed.start()
  return { feed, socket }
}

describe('parseStatusEvent — and what counts as no answer', () => {
  it('reads a real transition', () => {
    expect(parseStatusEvent(EVENT('w1:p1', 'working'))).toEqual({
      paneId: 'w1:p1',
      status: 'working'
    })
  })

  it('treats `unknown` as a RETRACTION — parsed, never mapped to a state', () => {
    // Two wrong readings of `unknown`, each caught live. Mapping it to idle
    // would end turns on herdr's uncertainty. But DISCARDING it (the first
    // design) left the previous status in the cache — a stale `working` that
    // held every turn open for five hours (the frozen checkpoint rail). The
    // event parses as itself; the feed ERASES the cached entry on it.
    expect(parseStatusEvent(EVENT('w1:p1', 'unknown'))).toEqual({
      paneId: 'w1:p1',
      status: 'unknown'
    })
  })

  it('ignores other event types and malformed lines', () => {
    expect(parseStatusEvent(JSON.stringify({ event: 'pane.scroll_changed', data: {} }))).toBeNull()
    expect(parseStatusEvent('{"id":"sub","result":{"type":"subscription_started"}}')).toBeNull()
    expect(parseStatusEvent('not json')).toBeNull()
    expect(parseStatusEvent('')).toBeNull()
  })
})

describe('the feed reports by COOKREW session name, not pane id', () => {
  it('translates pane id through the label', () => {
    // Callers hold session names; pane ids are herdr's private addressing and
    // must not leak into turn-tracker.
    const { feed, socket } = feedWith([{ paneId: 'w1:p1', label: 'cookrew_abc' }])
    socket.emit(EVENT('w1:p1', 'working') + '\n')
    expect(feed.statusFor('cookrew_abc')).toBe('working')
  })

  it('is null for a session herdr has never reported on', () => {
    const { feed } = feedWith([{ paneId: 'w1:p1', label: 'cookrew_abc' }])
    expect(feed.statusFor('cookrew_other')).toBeNull()
  })

  it('ignores events for panes Cookrew does not own', () => {
    const { feed, socket } = feedWith([{ paneId: 'w1:p1', label: 'cookrew_abc' }])
    socket.emit(EVENT('w1:p99', 'working') + '\n')
    expect(feed.statusFor('cookrew_abc')).toBeNull()
  })

  it('keeps the LATEST status across transitions', () => {
    const { feed, socket } = feedWith([{ paneId: 'w1:p1', label: 'cookrew_abc' }])
    for (const s of ['working', 'blocked', 'idle']) socket.emit(EVENT('w1:p1', s) + '\n')
    expect(feed.statusFor('cookrew_abc')).toBe('idle')
  })
})

describe('line framing', () => {
  it('handles an event SPLIT across chunks', () => {
    // A real socket splits wherever it likes; a half-parsed line must not be
    // dropped or throw.
    const { feed, socket } = feedWith([{ paneId: 'w1:p1', label: 'cookrew_abc' }])
    const line = EVENT('w1:p1', 'blocked') + '\n'
    socket.emit(line.slice(0, 20))
    expect(feed.statusFor('cookrew_abc')).toBeNull()
    socket.emit(line.slice(20))
    expect(feed.statusFor('cookrew_abc')).toBe('blocked')
  })

  it('handles several events JOINED in one chunk', () => {
    const { feed, socket } = feedWith([
      { paneId: 'w1:p1', label: 'a' },
      { paneId: 'w1:p2', label: 'b' }
    ])
    socket.emit(EVENT('w1:p1', 'working') + '\n' + EVENT('w1:p2', 'idle') + '\n')
    expect(feed.statusFor('a')).toBe('working')
    expect(feed.statusFor('b')).toBe('idle')
  })
})

describe('subscription', () => {
  it('subscribes to EVERY pane on one connection', () => {
    // pane.agent_status_changed requires a pane_id — there is no "all panes"
    // form — but one connection carries many subscriptions (verified live
    // with 17).
    const { socket } = feedWith([
      { paneId: 'w1:p1', label: 'a' },
      { paneId: 'w1:p2', label: 'b' },
      { paneId: 'w1:p3', label: 'c' }
    ])
    const sent = JSON.parse(socket.written[0]) as {
      method: string
      params: { subscriptions: { type: string; pane_id: string }[] }
    }
    expect(sent.method).toBe('events.subscribe')
    expect(sent.params.subscriptions.map((s) => s.pane_id)).toEqual(['w1:p1', 'w1:p2', 'w1:p3'])
    expect(sent.params.subscriptions.every((s) => s.type === 'pane.agent_status_changed')).toBe(true)
  })

  it('does not connect when there are no panes yet', () => {
    const feed = new HerdrStatusFeed({
      session: 'cookrew',
      configPath: '/c',
      listPanes: () => [],
      resolveSocketPath: () => '/tmp/h.sock',
      connect: () => {
        throw new Error('should not connect')
      }
    })
    expect(() => feed.start()).not.toThrow()
    expect(feed.connected).toBe(false)
    feed.stop()
  })

  it('survives the socket dropping without throwing', () => {
    const { feed, socket } = feedWith([{ paneId: 'w1:p1', label: 'a' }])
    expect(() => socket.close()).not.toThrow()
    expect(feed.connected).toBe(false)
    feed.stop()
  })

  it('coalesces a terminal-spawn burst into one subscription rebuild', async () => {
    let connects = 0
    let lists = 0
    const feed = new HerdrStatusFeed({
      session: 'cookrew',
      configPath: '/c',
      listPanes: () => {
        lists += 1
        return [{ paneId: 'w1:p1', label: 'cookrew_abc' }]
      },
      resolveSocketPath: () => '/tmp/h.sock',
      connect: () => {
        connects += 1
        return fakeSocket()
      }
    })
    feed.start()
    const initialLists = lists
    const initialConnects = connects

    for (let i = 0; i < 30; i += 1) feed.refreshSoon()
    await Promise.resolve()

    expect(lists - initialLists).toBe(1)
    expect(connects - initialConnects).toBe(1)
    feed.stop()
  })
})

describe('socketPathFor', () => {
  const LIST = JSON.stringify({
    sessions: [
      { name: 'default', socket_path: '/home/u/.config/herdr/herdr.sock' },
      { name: 'cookrew', socket_path: '/home/u/.config/herdr/sessions/cookrew/herdr.sock' }
    ]
  })

  it('reads socket_path — NOT `socket`', () => {
    // The JSON field and the human-readable column header differ; reading
    // `socket` yields undefined and the feed silently never connects.
    expect(socketPathFor('cookrew', LIST)).toBe('/home/u/.config/herdr/sessions/cookrew/herdr.sock')
  })

  it('never falls back to the USER session when ours is absent', () => {
    // Connecting to the default session would subscribe Cookrew to the user's
    // own panes.
    expect(socketPathFor('cookrew', JSON.stringify({ sessions: [{ name: 'default', socket_path: '/x' }] }))).toBeNull()
  })

  it('is null for junk rather than throwing into startup', () => {
    expect(socketPathFor('cookrew', 'no server running')).toBeNull()
  })
})

describe('panesFrom', () => {
  it('keeps only LABELLED panes — unlabelled ones are not Cookrew terminals', () => {
    const raw = JSON.stringify({
      result: {
        panes: [
          { pane_id: 'w1:p1', label: 'cookrew_abc' },
          { pane_id: 'w1:p2', label: null },
          { pane_id: 'w1:p3' }
        ]
      }
    })
    expect(panesFrom(raw)).toEqual([{ paneId: 'w1:p1', label: 'cookrew_abc' }])
  })

  it('is [] when herdr is not running', () => {
    expect(panesFrom('{"error":{"code":"server_not_running"}}')).toEqual([])
    expect(panesFrom('garbage')).toEqual([])
  })
})

describe('seeding — the blind spot events alone leave', () => {
  it('knows a pane state BEFORE any event arrives', () => {
    // Found live: events fire only on CHANGE, so a freshly started Cookrew
    // held no status for any of 17 panes that were all sitting at idle. Every
    // one of them would have fallen back to scraping for the whole run.
    const socket = fakeSocket()
    const feed = new HerdrStatusFeed({
      session: 'cookrew',
      configPath: '/c',
      listPanes: () => [{ paneId: 'w1:p1', label: 'cookrew_abc', status: 'idle' }],
      resolveSocketPath: () => '/tmp/h.sock',
      connect: () => socket
    })
    feed.start()
    expect(feed.statusFor('cookrew_abc')).toBe('idle')
    feed.stop()
  })

  it('lets a later event override the seed', () => {
    const socket = fakeSocket()
    const feed = new HerdrStatusFeed({
      session: 'cookrew',
      configPath: '/c',
      listPanes: () => [{ paneId: 'w1:p1', label: 'a', status: 'idle' }],
      resolveSocketPath: () => '/tmp/h.sock',
      connect: () => socket
    })
    feed.start()
    socket.emit(EVENT('w1:p1', 'working') + '\n')
    expect(feed.statusFor('a')).toBe('working')
    feed.stop()
  })

  it('does NOT seed from an unknown status', () => {
    const raw = JSON.stringify({
      result: { panes: [{ pane_id: 'w1:p1', label: 'a', agent_status: 'unknown' }] }
    })
    expect(panesFrom(raw)).toEqual([{ paneId: 'w1:p1', label: 'a' }])
  })

  it('carries a known status through panesFrom', () => {
    const raw = JSON.stringify({
      result: { panes: [{ pane_id: 'w1:p1', label: 'a', agent_status: 'blocked' }] }
    })
    expect(panesFrom(raw)).toEqual([{ paneId: 'w1:p1', label: 'a', status: 'blocked' }])
  })
})

describe('staleness — the frozen checkpoint rail (2026-08-09)', () => {
  // The conductor's turn store stopped at the SECOND the herdr server died
  // and stayed frozen for five hours: the feed cached `working`, the socket
  // dropped, and nothing ever retracted it — so turn-tracker's poll returned
  // early on every tick and no turn could finalize. Two invariants close it.

  it('a dropped connection ERASES every cached status', () => {
    const { feed, socket } = feedWith([
      { paneId: 'w1:p1', label: 'cookrew_abc', status: 'working' }
    ])
    expect(feed.statusFor('cookrew_abc')).toBe('working')
    socket.close()
    // Null means "no signal": callers fall back to inference, which is
    // strictly better than a fact about a world that has moved on.
    expect(feed.statusFor('cookrew_abc')).toBeNull()
  })

  it('an `unknown` event ERASES the entry rather than skipping the update', () => {
    const { feed, socket } = feedWith([
      { paneId: 'w1:p1', label: 'cookrew_abc', status: 'working' }
    ])
    expect(feed.statusFor('cookrew_abc')).toBe('working')
    socket.emit(EVENT('w1:p1', 'unknown') + '\n')
    expect(feed.statusFor('cookrew_abc')).toBeNull()
  })
})
