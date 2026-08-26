// Workspace focus must preserve live mirrors without eagerly attaching cold
// terminals. The plan is pure so both sides of that boundary stay testable.

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

  it('leaves cold incoming terminals detached for transcript zoom', () => {
    const plan = planWorkspaceSwitch(
      flagOff({ workspaceOfTerminal: (id) => (id.startsWith('old') ? 'ws-out' : undefined) })
    )
    expect(plan.boot).toEqual([])
  })

  it('re-registers an incoming terminal that is already attached', () => {
    const plan = planWorkspaceSwitch(flagOff())
    expect(plan.boot.map((t) => t.id)).toEqual(['new-1', 'new-2'])
  })

  it('hands the browser runtime exactly the focused workspace browsers', () => {
    const plan = planWorkspaceSwitch(flagOff())
    expect(plan.browsers.map((b) => b.id)).toEqual(['b-in'])
  })

  it('detaches and boots nothing when the first focused canvas is cold', () => {
    const plan = planWorkspaceSwitch(
      flagOff({ previousTerminalIds: [], workspaceOfTerminal: () => undefined })
    )
    expect(plan.detach).toEqual([])
    expect(plan.boot).toEqual([])
  })
})

describe('lazy attachment preserves already-live registration', () => {
  it('re-registers an attached terminal without booting a cold neighbor', () => {
    const plan = planWorkspaceSwitch(
      flagOff({
        focusedTerminals: [term('already-live'), term('cold')],
        workspaceOfTerminal: (id) => (id === 'already-live' ? 'ws-in' : undefined)
      })
    )
    expect(plan.boot.map((t) => t.id)).toEqual(['already-live'])
  })

  it('boots only terminals held by a resident workspace', () => {
    const focusedTerminals = [term('a'), term('b'), term('c')]
    const plan = planWorkspaceSwitch(
      flagOff({
        focusedTerminals,
        workspaceOfTerminal: (id) => (id === 'a' ? 'ws-in' : id === 'b' ? 'ws-out' : undefined)
      })
    )
    expect(plan.boot.map((t) => t.id)).toEqual(['a'])
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

  it('re-registers the already-attached incoming canvas', () => {
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
