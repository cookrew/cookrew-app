import { describe, expect, it } from 'vitest'
import { createBackendPhaseGate } from '../src/main/backend-phase-gate'
import type { TurnPhase } from '../src/shared/turn'

const RULE = '─'.repeat(60)
const PICKER = `❯ /model\n${RULE}\n  Select model\n  ❯ 1. Opus\n  Enter to set as default · Esc to cancel`
const WORKING = `❯ fix the bug\n⏺ Reading\n✻ Pondering… (3s · esc to interrupt)\n${RULE}\n❯ \n${RULE}`

function world(screen: { text: string | null }, herdr: { phase: TurnPhase | null }) {
  const applied: (TurnPhase | null)[] = []
  const timers: (() => void)[] = []
  const gate = createBackendPhaseGate({
    read: async () => screen.text,
    current: () => herdr.phase,
    apply: (_id, phase) => void applied.push(phase),
    schedule: (run) => timers.push(run),
    cancel: () => undefined
  })
  return { gate, applied, timers }
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
