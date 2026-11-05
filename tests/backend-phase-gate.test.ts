import { describe, expect, it } from 'vitest'
import { createBackendPhaseGate } from '../src/main/backend-phase-gate'
import type { TurnPhase } from '../src/shared/turn'

const RULE = '─'.repeat(60)
const PICKER = `❯ /model\n${RULE}\n  Select model\n  ❯ 1. Opus\n  Enter to set as default · Esc to cancel`
const WORKING = `❯ fix the bug\n⏺ Reading\n✻ Pondering… (3s · esc to interrupt)\n${RULE}\n❯ \n${RULE}`

function world(screen: { text: string | null }, herdr: { phase: TurnPhase | null }, turn: { open: boolean } = { open: false }) {
  const applied: (TurnPhase | null)[] = []
  const timers: (() => void)[] = []
  const reads = { count: 0 }
  const gate = createBackendPhaseGate({
    read: async () => {
      reads.count += 1
      return screen.text
    },
    current: () => herdr.phase,
    apply: (_id, phase) => void applied.push(phase),
    turnOpen: () => turn.open,
    schedule: (run) => timers.push(run),
    cancel: () => undefined
  })
  return { gate, applied, timers, reads }
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('backend phase gate', () => {
  it("refuses herdr's working while the /model picker is up", async () => {
    const { gate, applied } = world({ text: PICKER }, { phase: 'thinking' })
    gate.observe('t', 'thinking', true)
    await settle()
    expect(applied).toEqual([null])
  })

  it("refuses herdr's blocked on the picker", async () => {
    const { gate, applied } = world({ text: PICKER }, { phase: 'waiting' })
    gate.observe('t', 'waiting', true)
    await settle()
    expect(applied).toEqual([null])
  })

  it('passes real work through', async () => {
    const { gate, applied } = world({ text: WORKING }, { phase: 'thinking' })
    gate.observe('t', 'thinking', true)
    await settle()
    expect(applied).toEqual(['thinking'])
  })

  it('re-reads while refused, and lets a real turn through once its echo lands', async () => {
    const screen = { text: PICKER as string | null }
    const { gate, applied, timers } = world(screen, { phase: 'thinking' })
    gate.observe('t', 'thinking', true)
    await settle()
    screen.text = WORKING
    timers.shift()?.()
    await settle()
    expect(applied).toEqual([null, 'thinking'])
  })

  it('stops re-reading once herdr changes its word', async () => {
    const herdr = { phase: 'thinking' as TurnPhase | null }
    const { gate, applied, timers } = world({ text: PICKER }, herdr)
    gate.observe('t', 'thinking', true)
    await settle()
    herdr.phase = null
    timers.shift()?.()
    await settle()
    expect(applied).toEqual([null])
  })

  it('an unreadable pane leaves herdr standing; retractions and shells pass at once', async () => {
    const { gate, applied } = world({ text: null }, { phase: 'thinking' })
    gate.observe('t', 'thinking', true)
    gate.observe('u', null, true)
    gate.observe('v', 'thinking', false)
    await settle()
    expect(applied).toEqual([null, 'thinking', 'thinking'])
  })

  it('a retraction forgets the terminal, so the same word later is checked again', async () => {
    const { gate, applied } = world({ text: WORKING }, { phase: 'thinking' })
    gate.observe('t', 'thinking', true)
    await settle()
    gate.observe('t', null, true)
    gate.observe('t', 'thinking', true)
    await settle()
    expect(applied).toEqual(['thinking', null, 'thinking'])
  })

  it('the same word again is no news: no second read, the re-read timer keeps running', async () => {
    let reads = 0
    const applied: (TurnPhase | null)[] = []
    const gate = createBackendPhaseGate({
      read: async () => (reads++, PICKER),
      current: () => 'thinking',
      apply: (_id, phase) => void applied.push(phase),
      schedule: () => 1,
      cancel: () => undefined
    })
    gate.observe('t', 'thinking', true)
    await settle()
    gate.observe('t', 'thinking', true)
    await settle()
    expect(reads).toBe(1)
    expect(applied).toEqual([null])
  })

  it('a late read for an older observation is dropped', async () => {
    let release: (s: string) => void = () => undefined
    const applied: (TurnPhase | null)[] = []
    const gate = createBackendPhaseGate({
      read: () => new Promise((r) => (release = r)),
      current: () => null,
      apply: (_id, phase) => void applied.push(phase)
    })
    gate.observe('t', 'thinking', true)
    gate.observe('t', null, true)
    release(WORKING)
    await settle()
    expect(applied).toEqual([null])
  })
})

// RETRACTING IS WRONG OVER AN OPEN TURN (owner, 2026-11-05: a running agent read
// DONE after a restart). herdr falling silent says nothing while the agent's own
// file has not closed the turn: the pane says whether it still runs. An open turn
// is not proof of a running one (Claude writes no marker for an interrupted turn),
// so the spinner decides, never the file alone.
describe('herdr going quiet over an open turn', () => {
  const RESTING = `❯ fix the bug\n⏺ Stopped here\n${RULE}\n❯ \n${RULE}`

  it('holds the agent working while its pane shows the spinner', async () => {
    const { gate, applied } = world({ text: WORKING }, { phase: null }, { open: true })
    gate.observe('t', null, true)
    await settle()
    expect(applied).toEqual(['thinking'])
  })

  it('retracts once the pane shows no spinner: an interrupted turn stays open for ever', async () => {
    const { gate, applied } = world({ text: RESTING }, { phase: null }, { open: true })
    gate.observe('t', null, true)
    await settle()
    expect(applied).toEqual([null])
  })

  it('an unreadable pane retracts: nothing stands behind the turn', async () => {
    const { gate, applied } = world({ text: null }, { phase: null }, { open: true })
    gate.observe('t', null, true)
    await settle()
    expect(applied).toEqual([null])
  })

  it('a closed turn retracts at once, and no pane is read', () => {
    const { gate, applied, reads } = world({ text: WORKING }, { phase: null }, { open: false })
    gate.observe('t', null, true)
    expect(applied).toEqual([null])
    expect(reads.count).toBe(0)
  })

  it('a shell has no turn to hold', () => {
    const { gate, applied, reads } = world({ text: WORKING }, { phase: null }, { open: true })
    gate.observe('t', null, false)
    expect(applied).toEqual([null])
    expect(reads.count).toBe(0)
  })

  it('reads the pane again while it holds, and retracts when the spinner stops', async () => {
    const screen = { text: WORKING as string | null }
    const { gate, applied, timers } = world(screen, { phase: null }, { open: true })
    gate.observe('t', null, true)
    await settle()
    screen.text = RESTING
    timers.shift()?.()
    await settle()
    expect(applied).toEqual(['thinking', null])
    expect(timers).toHaveLength(0)
  })

  it('retracts when the file closes the turn, whatever the pane shows', async () => {
    const turn = { open: true }
    const { gate, applied, timers } = world({ text: WORKING }, { phase: null }, turn)
    gate.observe('t', null, true)
    await settle()
    turn.open = false
    timers.shift()?.()
    await settle()
    expect(applied).toEqual(['thinking', null])
  })

  it('the sweep repeating herdr\'s silence is no news: one read, and the hold survives it', async () => {
    const { gate, reads, timers } = world({ text: WORKING }, { phase: null }, { open: true })
    gate.observe('t', null, true)
    await settle()
    gate.observe('t', null, true)
    await settle()
    expect(reads.count).toBe(1)
    expect(timers).toHaveLength(1)
  })

  it('a turn found resting is not read again on every sweep', async () => {
    const { gate, reads } = world({ text: RESTING }, { phase: null }, { open: true })
    gate.observe('t', null, true)
    await settle()
    gate.observe('t', null, true)
    await settle()
    expect(reads.count).toBe(1)
  })

  it('herdr speaking again takes over from the hold', async () => {
    const herdr = { phase: null as TurnPhase | null }
    const { gate, applied, timers } = world({ text: WORKING }, herdr, { open: true })
    gate.observe('t', null, true)
    await settle()
    herdr.phase = 'waiting'
    gate.observe('t', 'waiting', true)
    await settle()
    timers.shift()?.()
    await settle()
    expect(applied).toEqual(['thinking', 'waiting'])
  })

  it('stops holding after a bound: a spinner stuck in the pane is not a turn for ever', async () => {
    const { gate, applied, timers } = world({ text: WORKING }, { phase: null }, { open: true })
    gate.observe('t', null, true)
    await settle()
    for (let i = 0; i < 400 && timers.length > 0; i += 1) {
      timers.shift()?.()
      await settle()
    }
    expect(timers).toHaveLength(0)
    expect(applied.at(-1)).toBeNull()
  })
})
