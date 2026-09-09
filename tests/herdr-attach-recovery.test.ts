// "herdr: lost connection to server: Resource temporarily unavailable (os error 35)"
//
// The line a card is left showing when its `herdr agent attach` client hits a
// transient socket EAGAIN and gives up. The server is alive and the pane is
// alive; only the client died. PtyManager's exit handler dropped the session
// and stopped there, so the card kept that sentence and the agent behind it
// went unreachable until someone recovered the terminal by hand.
//
// These pin the reattach decision. The live-session wiring that keeps existing
// transcript subscribers connected is covered in herdr-live-transcript-recovery.

import { describe, expect, it } from 'vitest'
import {
  MAX_REATTACHES,
  REATTACH_WINDOW_MS,
  decideReattach,
  freshReattachState
} from '../src/main/herdr-attach-recovery'

/** Verbatim, as it appears in the pane. */
const EAGAIN = 'herdr: lost connection to server: Resource temporarily unavailable (os error 35)'
const T0 = 1_000_000

describe('the reported drop', () => {
  it('reattaches', () => {
    const d = decideReattach({ exitCode: 1, tail: EAGAIN }, freshReattachState(), T0)
    expect(d.reattach).toBe(true)
    if (!d.reattach) return
    expect(d.attempt).toBe(1)
    expect(d.delayMs).toBeGreaterThan(0)
  })

  it('backs off further each time', () => {
    let state = freshReattachState()
    const delays: number[] = []
    for (let i = 0; i < MAX_REATTACHES; i += 1) {
      const d = decideReattach({ exitCode: 1, tail: EAGAIN }, state, T0)
      if (!d.reattach) throw new Error(`refused on attempt ${i + 1}`)
      delays.push(d.delayMs)
      state = d.state
    }
    for (let i = 1; i < delays.length; i += 1) expect(delays[i]).toBeGreaterThan(delays[i - 1])
  })

  it('gives up rather than looping forever', () => {
    let state = freshReattachState()
    for (let i = 0; i < MAX_REATTACHES; i += 1) {
      const d = decideReattach({ exitCode: 1, tail: EAGAIN }, state, T0)
      if (!d.reattach) throw new Error('refused too early')
      state = d.state
    }
    const spent = decideReattach({ exitCode: 1, tail: EAGAIN }, state, T0)
    expect(spent.reattach).toBe(false)
    if (!spent.reattach) expect(spent.reason).toBe('budget-spent')
  })

  it('forgives once the window has passed', () => {
    // Otherwise an app up for days accumulates its way to a permanent refusal.
    const spent = { attempts: MAX_REATTACHES, since: T0 }
    const later = decideReattach(
      { exitCode: 1, tail: EAGAIN },
      spent,
      T0 + REATTACH_WINDOW_MS + 1
    )
    expect(later.reattach).toBe(true)
    if (later.reattach) expect(later.attempt).toBe(1)
  })
})

describe('what it refuses to resurrect', () => {
  it('a clean exit — the user closed the card', () => {
    const d = decideReattach({ exitCode: 0, tail: '' }, freshReattachState(), T0)
    expect(d.reattach).toBe(false)
    if (!d.reattach) expect(d.reason).toBe('clean-exit')
  })

  it('the exact disconnect wins even when herdr maps it to exit zero', () => {
    // Deliberate disposal is filtered by PtySession before this decision. An
    // exit-zero disconnect from the client is still a dead live transcript.
    const d = decideReattach({ exitCode: 0, tail: EAGAIN }, freshReattachState(), T0)
    expect(d.reattach).toBe(true)
  })

  it('a pane that is genuinely gone', () => {
    // Respawning just reprints agent_not_found; the repair is registry-side.
    for (const tail of ['agent_not_found', 'server_not_running', 'no such pane w1:p9']) {
      const d = decideReattach({ exitCode: 1, tail }, freshReattachState(), T0)
      expect(d.reattach).toBe(false)
      if (!d.reattach) expect(d.reason).toBe('pane-gone')
    }
  })

  it('an ordinary non-zero exit with nothing transient about it', () => {
    const d = decideReattach(
      { exitCode: 1, tail: 'command not found: claude' },
      freshReattachState(),
      T0
    )
    expect(d.reattach).toBe(false)
    if (!d.reattach) expect(d.reason).toBe('not-transient')
  })

  it('pane-gone beats transient when both appear', () => {
    // A tail carrying both must NOT reattach: the unrecoverable fact wins.
    const d = decideReattach(
      { exitCode: 1, tail: `${EAGAIN}\nagent_not_found` },
      freshReattachState(),
      T0
    )
    expect(d.reattach).toBe(false)
    if (!d.reattach) expect(d.reason).toBe('pane-gone')
  })
})
