import { describe, expect, it } from 'vitest'
import { confirmDelivery, type DeliveryDeps } from '../src/main/ask-delivery'

// The confirmation step, against the owner's five reproductions.
//
// Every case below was hit driving real agents: a brief that pasted and sat as
// `[Pasted text #N +M lines]`, a brief that vanished with no paste at all, and
// exit 0 reported for both. The tests are written as those three worlds, so a
// change that re-merges them goes red.

const PROMPT = 'Run the F2 simulation and report the counts.'

function deps(over: Partial<DeliveryDeps> = {}): DeliveryDeps & { submits: string[] } {
  const submits: string[] = []
  return {
    submits,
    turnCountOf: () => 4,
    capture: () => 'idle\n> ',
    submit: (id) => void submits.push(id),
    settle: async () => undefined,
    ...over
  } as DeliveryDeps & { submits: string[] }
}

const run = (d: DeliveryDeps, turnsBefore: number | null = 4) =>
  confirmDelivery(d, { terminalId: 'term-1', prompt: PROMPT, turnsBefore })

describe('a turn that actually ran', () => {
  it('reports completed when the tracker recorded a new turn', async () => {
    const d = deps({ turnCountOf: () => 5 })
    expect(await run(d)).toEqual({ outcome: 'completed', submitRetries: 0 })
  })

  it('does not credit a turn that was already there before delivery', async () => {
    // The correlation trap in miniature: same count, so nothing new ran. A
    // check that only asked "is there a turn?" would report success here.
    const d = deps({ turnCountOf: () => 4, capture: () => 'unrelated screen' })
    expect((await run(d)).outcome).toBe('dropped')
  })
})

describe('the swallowed carriage return — the reproduction', () => {
  it('sends the CR again and reports completed once the turn starts', async () => {
    // The paste is in the box; the first CR was folded into the ingest. This
    // is the owner following ask with a raw CR, done by the product instead.
    let turns = 4
    const d = deps({
      capture: () => `> ${PROMPT}`,
      turnCountOf: () => turns,
      submit: () => {
        turns += 1
      }
    })
    expect(await run(d)).toEqual({ outcome: 'completed', submitRetries: 1 })
  })

  it('retries the CR twice, then stops and says unsubmitted', async () => {
    const d = deps({ capture: () => `> ${PROMPT}`, turnCountOf: () => 4 })
    const report = await run(d)
    expect(report).toEqual({ outcome: 'unsubmitted', submitRetries: 2 })
    // Bounded: an unbounded loop would hammer a pane that is never coming back.
    expect(d.submits).toHaveLength(2)
  })

  it('NEVER re-sends the brief — only the carriage return', async () => {
    // The destructive remedy. Re-pasting into a box that already holds the
    // text submits two copies of the brief; the submit seam takes a terminal
    // id and no text at all, so this cannot regress by accident.
    const d = deps({ capture: () => `> ${PROMPT}`, turnCountOf: () => 4 })
    await run(d)
    expect(d.submits.every((entry) => entry === 'term-1')).toBe(true)
  })
})

describe('a brief that never arrived', () => {
  it('reports dropped when the box does not hold it', async () => {
    const d = deps({ capture: () => 'a totally unrelated screen\n> ', turnCountOf: () => 4 })
    expect(await run(d)).toEqual({ outcome: 'dropped', submitRetries: 0 })
  })

  it('does not send a CR into an empty box', async () => {
    // Submitting here would run whatever the box already contained — someone
    // else's half-typed command, or nothing at all.
    const d = deps({ capture: () => 'unrelated', turnCountOf: () => 4 })
    await run(d)
    expect(d.submits).toEqual([])
  })
})

describe('a fact about US is not a fact about THEM', () => {
  it('an UNTRACKED terminal is unverifiable, never dropped', async () => {
    // Detached pane, dormant workspace. The agent may be working perfectly;
    // we simply have no view. Telling the owner "dropped" here is the same
    // class of lie as reporting our facilitator outage as their invalid
    // payment — our uncertainty in the language of their failure.
    const d = deps({ turnCountOf: () => null })
    expect(await run(d, null)).toEqual({ outcome: 'unverifiable', submitRetries: 0 })
  })

  it('never sends a CR into a terminal it cannot observe', async () => {
    // The dangerous combination: blind AND acting. A CR sent to a pane we
    // cannot read could submit anything sitting in it.
    const d = deps({ turnCountOf: () => null })
    await run(d, null)
    expect(d.submits).toEqual([])
  })

  it('an unreadable pane is unverifiable, not dropped', async () => {
    const d = deps({ capture: () => null, turnCountOf: () => 4 })
    expect((await run(d)).outcome).toBe('unverifiable')
  })

  it('distinguishes a blind read from an empty box, which look identical', async () => {
    const blind = deps({ capture: () => null, turnCountOf: () => 4 })
    const empty = deps({ capture: () => '', turnCountOf: () => 4 })
    expect((await run(blind)).outcome).toBe('unverifiable')
    expect((await run(empty)).outcome).toBe('dropped')
  })
})
