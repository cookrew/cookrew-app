import { afterEach, describe, expect, it } from 'vitest'
import {
  askedAgentStatus,
  probeOnce,
  type ProbeDeps
} from '../src/main/board-index'
import {
  HerdrStatusFeed,
  setStatusFeed,
  type FeedPane,
  type StatusSocket
} from '../src/main/herdr-agent-status'
import { setMultiplexer, sessionNameFor } from '../src/main/pty'
import type { Multiplexer } from '../src/main/multiplexer'

// herdr as the STATUS SOURCE for the board's probe layer.
//
// The rule being pinned: a status that is ASKED (herdr's pushed agent state)
// beats a status that is INFERRED (regex over a captured pane) — but a status
// that is INVENTED is worse than either. So herdr answers replace the scrape
// where they exist, null falls back to the scrape exactly as before, and
// idle/done answers set NOTHING: the ledger keeps deciding unread vs offline,
// because herdr cannot know whether a result was seen and must never clear an
// unread marker.

const WORKING_PANE = '✻ Baking… (esc to interrupt)'
const WAITING_PANE = 'Do you want to proceed?\n❯ 1. Yes\n  2. No'

function probeDeps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    listSessions: () => [],
    capturePane: () => '',
    knownTerminalIds: () => [],
    isAttached: () => false,
    sessionNameFor: (id) => `cookrew_${id}`,
    detectWorking: (chunk) => /esc to interrupt/i.test(chunk),
    detectWaiting: (lines) => lines.some((l) => /Do you want to proceed\?/.test(l)),
    ...over
  }
}

describe('probeOnce — herdr answers beat the pane scrape', () => {
  it('asked working → working, and capture-pane is never run', () => {
    let captured = 0
    const phases = probeOnce(
      probeDeps({
        listSessions: () => ['cookrew_t1'],
        knownTerminalIds: () => ['t1'],
        askedStatus: () => 'working',
        capturePane: () => {
          captured += 1
          return ''
        }
      })
    )
    expect(phases.get('t1')).toBe('working')
    expect(captured).toBe(0)
  })

  it('asked blocked → waiting (the existing needs-attention state)', () => {
    const phases = probeOnce(
      probeDeps({
        listSessions: () => ['cookrew_t1'],
        knownTerminalIds: () => ['t1'],
        askedStatus: () => 'blocked',
        capturePane: () => ''
      })
    )
    expect(phases.get('t1')).toBe('waiting')
  })

  it('asked idle sets NO phase and suppresses the scrape of a stale spinner', () => {
    // A detached pane's last painted frame can still show a spinner long
    // after the agent stopped. herdr answered — the frozen pixels must not
    // override it — and the answer maps to the existing idle treatment:
    // no probe entry, so the ledger decides unread vs offline via seenAt.
    let captured = 0
    const phases = probeOnce(
      probeDeps({
        listSessions: () => ['cookrew_t1'],
        knownTerminalIds: () => ['t1'],
        askedStatus: () => 'idle',
        capturePane: () => {
          captured += 1
          return WORKING_PANE
        }
      })
    )
    expect(phases.size).toBe(0)
    expect(captured).toBe(0)
  })

  it('asked done is treated exactly like idle — completion is the ledger’s call', () => {
    const phases = probeOnce(
      probeDeps({
        listSessions: () => ['cookrew_t1'],
        knownTerminalIds: () => ['t1'],
        askedStatus: () => 'done',
        capturePane: () => WORKING_PANE
      })
    )
    expect(phases.size).toBe(0)
  })

  it('null (no signal) falls back to the scrape, unchanged', () => {
    const working = probeOnce(
      probeDeps({
        listSessions: () => ['cookrew_t1'],
        knownTerminalIds: () => ['t1'],
        askedStatus: () => null,
        capturePane: () => WORKING_PANE
      })
    )
    expect(working.get('t1')).toBe('working')

    const waiting = probeOnce(
      probeDeps({
        listSessions: () => ['cookrew_t1'],
        knownTerminalIds: () => ['t1'],
        askedStatus: () => null,
        capturePane: () => WAITING_PANE
      })
    )
    expect(waiting.get('t1')).toBe('waiting')
  })

  it('attached terminals are never asked — L1 already owns them', () => {
    let asked = 0
    const phases = probeOnce(
      probeDeps({
        listSessions: () => ['cookrew_t1'],
        knownTerminalIds: () => ['t1'],
        isAttached: () => true,
        askedStatus: () => {
          asked += 1
          return 'working'
        }
      })
    )
    expect(phases.size).toBe(0)
    expect(asked).toBe(0)
  })

  it('a terminal with no live pane gets no row, even if herdr has a stale answer', () => {
    let asked = 0
    const phases = probeOnce(
      probeDeps({
        listSessions: () => ['cookrew_other'],
        knownTerminalIds: () => ['t1'],
        askedStatus: () => {
          asked += 1
          return 'working'
        }
      })
    )
    expect(phases.size).toBe(0)
    expect(asked).toBe(0)
  })

  it('deps without askedStatus behave exactly as before (scrape only)', () => {
    const phases = probeOnce(
      probeDeps({
        listSessions: () => ['cookrew_t1'],
        knownTerminalIds: () => ['t1'],
        capturePane: () => WORKING_PANE
      })
    )
    expect(phases.get('t1')).toBe('working')
  })
})

// ---------------------------------------------------------------------------
// askedAgentStatus — the gate. Capability, never backend name.
// ---------------------------------------------------------------------------

function fakeSocket(): StatusSocket {
  return {
    on() {},
    write() {},
    end() {}
  }
}

function liveFeed(panes: FeedPane[]): HerdrStatusFeed {
  const feed = new HerdrStatusFeed({
    session: 'cookrew',
    configPath: '/tmp/none.toml',
    listPanes: () => panes,
    resolveSocketPath: () => '/tmp/h.sock',
    connect: () => fakeSocket()
  })
  feed.start()
  return feed
}

function fakeMux(agentLifecycle: boolean): Multiplexer {
  return {
    id: 'fake-for-test',
    capabilities: { agentLifecycle },
    available: () => true,
    sessionExists: () => false,
    listSessions: () => [],
    killSession: () => {},
    ensureSession: () => {},
    attachSpawn: () => {
      throw new Error('not under test')
    },
    capture: () => null,
    scrollState: () => ({ atBottom: true, position: 0 }),
    panePid: () => null,
    paneLaunch: () => null,
    jumpToText: () => {},
    exitCopyMode: () => {},
    reloadConfig: () => {}
  } as unknown as Multiplexer
}

describe('askedAgentStatus — gated on capabilities.agentLifecycle', () => {
  afterEach(() => setStatusFeed(null))

  // Runs FIRST, before any setMultiplexer below: with no active backend at
  // all there is nobody to vouch for the feed, so the answer is no signal.
  it('is null when no multiplexer is active, even with a live feed', () => {
    setStatusFeed(liveFeed([{ paneId: 'p1', label: sessionNameFor('t1'), status: 'working' }]))
    expect(askedAgentStatus('t1')).toBeNull()
  })

  it('is null when the backend lacks agentLifecycle, even with a live feed', () => {
    setMultiplexer(fakeMux(false))
    setStatusFeed(liveFeed([{ paneId: 'p1', label: sessionNameFor('t1'), status: 'working' }]))
    expect(askedAgentStatus('t1')).toBeNull()
  })

  it('answers from the feed when the capability is present, keyed by session name', () => {
    setMultiplexer(fakeMux(true))
    setStatusFeed(
      liveFeed([
        { paneId: 'p1', label: sessionNameFor('t1'), status: 'working' },
        { paneId: 'p2', label: sessionNameFor('t2'), status: 'blocked' }
      ])
    )
    expect(askedAgentStatus('t1')).toBe('working')
    expect(askedAgentStatus('t2')).toBe('blocked')
  })

  it('is null with the capability but no feed — no signal, never a guess', () => {
    setMultiplexer(fakeMux(true))
    expect(askedAgentStatus('unheard-of')).toBeNull()
  })
})
