import { describe, expect, it } from 'vitest'
import {
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
  panes: { paneId: string; label: string }[]
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

  it('treats `unknown` as NO SIGNAL, not as idle', () => {
    // The single most important line in this file. herdr reports `unknown`
    // when its detector cannot tell; mapping that to idle would end turns on
    // herdr's uncertainty — worse than the heuristic it replaces.
    expect(parseStatusEvent(EVENT('w1:p1', 'unknown'))).toBeNull()
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
