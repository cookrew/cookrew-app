// Launching Cookrew from inside a Cookrew terminal kills Cookrew.
//
// 2026-08-27: the app died by SIGTERM ~90s into every boot. No crash report, no
// stack, only `[vite] server connection lost`. It was not a crash at all — the
// parent chain was
//
//     Electron . <- electron-vite dev <- npm run dev <- codex <- herdr server
//
// so an agent had run the dev server inside a pane the app itself hosts. A pane
// exports HERDR_SESSION / COOKREW_TERMINAL_ID into whatever runs in it, the new
// instance adopted that same session, reattached every pane with --takeover,
// and killed the process group it was hanging from.
//
// The environments below are verbatim from the failing process.

import { describe, expect, it } from 'vitest'
import { selfHostRefusalMessage, selfHostedLaunch } from '../src/main/self-host-guard'

const OWN = 'cookrew'

/** Captured from the app process that kept dying (pid 25034). */
const INSIDE_OUR_OWN_CARD = {
  TERM_PROGRAM: 'Cookrew',
  HERDR_SESSION: 'cookrew',
  HERDR_TAB_ID: 'w1:t1',
  HERDR_ENV: '1',
  COOKREW_TERMINAL_ID: 'db9b45d0-1793-4ca3-904a-696374e6446a',
  COOKREW_MULTI_INSTANCE: '1'
}

describe('the launch that killed the app', () => {
  it('is refused', () => {
    const refusal = selfHostedLaunch(INSIDE_OUR_OWN_CARD, OWN)
    expect(refusal).not.toBeNull()
    expect(refusal?.terminalId).toBe('db9b45d0-1793-4ca3-904a-696374e6446a')
  })

  it('says which pane, and how to get out of it', () => {
    // A refusal nobody can act on just moves the confusion, so the message has
    // to name the terminal and the fix, not only the fact.
    const message = selfHostRefusalMessage(selfHostedLaunch(INSIDE_OUR_OWN_CARD, OWN)!)
    expect(message).toContain('db9b45d0-1793-4ca3-904a-696374e6446a')
    expect(message).toContain('outside')
  })
})

describe('what it must NOT refuse', () => {
  it('a normal terminal', () => {
    expect(selfHostedLaunch({ TERM_PROGRAM: 'Apple_Terminal', SHELL: '/bin/zsh' }, OWN)).toBeNull()
  })

  it("a pane belonging to somebody else's herdr session", () => {
    // Not our multiplexer, not our business — we will never take this pane over.
    expect(
      selfHostedLaunch({ HERDR_SESSION: 'someones-own', COOKREW_TERMINAL_ID: 'abc' }, OWN)
    ).toBeNull()
  })

  it('a herdr session of our name with no Cookrew card behind it', () => {
    // A developer may run a herdr session called cookrew by hand. Without a
    // terminal id there is no pane of ours to stand on.
    expect(selfHostedLaunch({ HERDR_SESSION: 'cookrew' }, OWN)).toBeNull()
    expect(selfHostedLaunch({ HERDR_SESSION: 'cookrew', COOKREW_TERMINAL_ID: '' }, OWN)).toBeNull()
  })

  it('a Cookrew-looking env with no session at all', () => {
    expect(selfHostedLaunch({ TERM_PROGRAM: 'Cookrew', COOKREW_TERMINAL_ID: 'abc' }, OWN)).toBeNull()
  })

  it('an empty environment', () => {
    expect(selfHostedLaunch({}, OWN)).toBeNull()
  })
})
