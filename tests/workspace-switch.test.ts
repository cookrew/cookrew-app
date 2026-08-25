// Flag-off equivalence at the index.ts seam (review L5).
//
// I claimed "flag off is behaviour-identical" through three steps and it was
// not true — the reviewer opened round 1 with that. The claim was unfalsifiable
// because the switch handler lived inline in index.ts, tangled with Electron
// and a dozen singletons, so nothing could call it.
//
// These are the assertions that would have caught H1 without a reviewer: with
// one resident workspace the plan must equal the pre-refactor teardown exactly,
// and EVERY focused terminal must be re-registered whether or not its PTY is
// already live.

import { describe, expect, it } from 'vitest'
import { planWorkspaceSwitch, type SwitchFacts } from '../src/main/workspace-switch'

interface Term {
  id: string
}
interface Browser {
  id: string
}

const term = (id: string): Term => ({ id })
const browser = (id: string): Browser => ({ id })

/**
 * The world as it is with the flag OFF: exactly one workspace resident, and it
 * is the one just switched TO. The outgoing workspace has already been evicted
 * by the store before the handler runs.
 */
function flagOff(over: Partial<SwitchFacts<Term, Browser>> = {}): SwitchFacts<Term, Browser> {
  return {
    previousTerminalIds: ['old-1', 'old-2'],
    workspaceOfTerminal: (id) => (id.startsWith('old') ? 'ws-out' : 'ws-in'),
    isResident: (ws) => ws === 'ws-in',
    focusedTerminals: [term('new-1'), term('new-2')],
    residentBrowsers: [browser('b-in')],
    ...over
  }
}

describe('flag OFF is the pre-refactor teardown, exactly', () => {
  it('detaches every outgoing terminal', () => {
    const plan = planWorkspaceSwitch(flagOff())
    expect(plan.detach).toEqual(['old-1', 'old-2'])
  })

  it('boots every incoming terminal', () => {
    const plan = planWorkspaceSwitch(flagOff())
    expect(plan.boot.map((t) => t.id)).toEqual(['new-1', 'new-2'])
  })

  it('hands the browser runtime exactly the focused workspace browsers', () => {
    const plan = planWorkspaceSwitch(flagOff())
    expect(plan.browsers.map((b) => b.id)).toEqual(['b-in'])
  })

  it('detaches nothing when there was nothing to leave (first boot)', () => {
    const plan = planWorkspaceSwitch(flagOff({ previousTerminalIds: [] }))
    expect(plan.detach).toEqual([])
    expect(plan.boot).toHaveLength(2)
  })
})

describe('the H1 invariant — registration is not the spawn', () => {
  it('boots a focused terminal whose PTY is ALREADY live', () => {
    // H1 exactly: an `if (ptys.isLive) continue` looked like it skipped a
    // redundant spawn. It skipped owner-input hooks, the producer lease, turn
    // tracking, registry recording and pending-inject delivery with it.
    const plan = planWorkspaceSwitch(
      flagOff({
        focusedTerminals: [term('already-live'), term('cold')],
        // Cut into this workspace with its PTY still held — the reachable
        // flag-off path, via a TeamClipboard cut plus a switch.
        workspaceOfTerminal: (id) => (id === 'already-live' ? 'ws-in' : 'ws-out')
      })
    )
    expect(plan.boot.map((t) => t.id)).toEqual(['already-live', 'cold'])
  })

  it('boot is the focused set verbatim — never filtered by liveness', () => {
    const focusedTerminals = [term('a'), term('b'), term('c')]
    for (const holder of ['ws-in', 'ws-out', undefined]) {
      const plan = planWorkspaceSwitch(
        flagOff({ focusedTerminals, workspaceOfTerminal: () => holder })
      )
      expect(plan.boot).toBe(focusedTerminals)
    }
  })
})

describe('flag ON — a switch stops being a teardown', () => {
  const flagOn = (over: Partial<SwitchFacts<Term, Browser>> = {}): SwitchFacts<Term, Browser> =>
    flagOff({
      // Both workspaces held in memory: the point of step 2.
      isResident: () => true,
      residentBrowsers: [browser('b-in'), browser('b-out')],
      ...over
    })

  it('keeps the workspace you left attached', () => {
    const plan = planWorkspaceSwitch(flagOn())
    expect(plan.detach).toEqual([])
  })

  it('still re-registers the incoming canvas', () => {
    const plan = planWorkspaceSwitch(flagOn())
    expect(plan.boot.map((t) => t.id)).toEqual(['new-1', 'new-2'])
  })

  it('hands the runtime the UNION of resident browsers', () => {
    // replaceNodes stops anything absent, so passing one workspace's browsers
    // while another session is resident would kill that session's pages.
    const plan = planWorkspaceSwitch(flagOn())
    expect(plan.browsers.map((b) => b.id)).toEqual(['b-in', 'b-out'])
  })

  it('detaches a workspace that HAS drained, even with others resident', () => {
    const plan = planWorkspaceSwitch(
      flagOn({ isResident: (ws) => ws !== 'ws-out' })
    )
    expect(plan.detach).toEqual(['old-1', 'old-2'])
  })
})

describe('a terminal held by nothing', () => {
  it('is detached — nothing can be responsible for it later', () => {
    const plan = planWorkspaceSwitch(
      flagOff({ previousTerminalIds: ['orphan'], workspaceOfTerminal: () => undefined })
    )
    expect(plan.detach).toEqual(['orphan'])
  })

  it('is detached even when every known workspace is resident', () => {
    const plan = planWorkspaceSwitch(
      flagOff({
        previousTerminalIds: ['orphan'],
        workspaceOfTerminal: () => undefined,
        isResident: () => true
      })
    )
    expect(plan.detach).toEqual(['orphan'])
  })
})
