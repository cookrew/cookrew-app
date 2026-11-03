// WHAT GOES DOWN THE DIRECT LINK NEXT (main/rtc-outbox.ts).
//
// werift sends every channel of a peer from one FIFO, so a pong waited behind
// a snapshot: measured 1 ms idle, 90-190 ms under two workspace downloads on
// loopback, seconds over a phone's Wi-Fi. The outbox keeps werift's queue
// short and decides what goes next.
import { describe, expect, it } from 'vitest'
import { createRtcOutbox, type OutboxSink } from '../src/main/rtc-outbox'

/** A channel that holds what it is given until `drain` says it went. */
const channel = (): OutboxSink & { readonly sent: string[]; drain: () => void } => {
  const sent: string[] = []
  let held = 0
  return {
    sent,
    send: (text) => {
      sent.push(text)
      held += text.length
    },
    get bufferedAmount() {
      return held
    },
    drain: () => void (held = 0)
  }
}

const manual = () => {
  let pending: (() => void) | null = null
  return {
    schedule: (run: () => void) => {
      pending = run
      return 'timer'
    },
    cancel: () => void (pending = null),
    fire: () => {
      const run = pending
      pending = null
      run?.()
    }
  }
}

describe('the outbox', () => {
  it('sends straight through while the channel is empty', () => {
    const out = createRtcOutbox()
    const sink = channel()
    out.send(sink, 'link', 'pong')
    expect(sink.sent).toEqual(['pong'])
  })

  it('lets a pong past a snapshot already queued — the head-of-line block', () => {
    const timers = manual()
    const out = createRtcOutbox({ budget: 100, urgent: 10, ...timers })
    const sink = channel()
    const bulk = Array.from({ length: 5 }, () => 'B'.repeat(60))
    out.send(sink, 'x1', bulk)
    expect(sink.sent).toEqual([bulk[0], bulk[1]])
    out.send(sink, 'link', 'pong')
    sink.drain()
    out.pump()
    expect(sink.sent[2]).toBe('pong')
  })

  it('keeps a lane in order and takes turns between bulk lanes', () => {
    const out = createRtcOutbox({ budget: 1, urgent: 0, schedule: () => 'timer', cancel: () => undefined })
    const sink = channel()
    // The channel is full, so both lanes are queued before either is served.
    out.send(sink, 'link', 'L')
    out.send(sink, 'a', ['a1', 'a2', 'a3'])
    out.send(sink, 'b', ['b1', 'b2'])
    for (let i = 0; i < 5; i += 1) {
      sink.drain()
      out.pump()
    }
    expect(sink.sent).toEqual(['L', 'a1', 'b1', 'a2', 'b2', 'a3'])
  })

  it('replaces a browser frame that has not started to go with the newer one', () => {
    const out = createRtcOutbox({ budget: 1, schedule: () => 'timer', cancel: () => undefined })
    const sink = channel()
    out.send(sink, 's1', 'frame-1', { replaceable: true })
    out.send(sink, 's1', 'frame-2', { replaceable: true })
    out.send(sink, 's1', 'frame-3', { replaceable: true })
    expect(out.queued('s1')).toBe('frame-3'.length)
    sink.drain()
    out.pump()
    expect(sink.sent).toEqual(['frame-1', 'frame-3'])
  })

  it('never replaces an ordinary message', () => {
    const out = createRtcOutbox({ budget: 1, schedule: () => 'timer', cancel: () => undefined })
    const sink = channel()
    out.send(sink, 's1', 'first')
    out.send(sink, 's1', 'keep')
    out.send(sink, 's1', 'frame', { replaceable: true })
    expect(out.queued('s1')).toBe('keep'.length + 'frame'.length)
  })

  it('tells a paused socket when its lane is low again', () => {
    const out = createRtcOutbox({ budget: 1, schedule: () => 'timer', cancel: () => undefined })
    const sink = channel()
    out.send(sink, 's1', ['1111', '2222', '3333'])
    let resumed = 0
    out.whenBelow('s1', 4, () => (resumed += 1))
    expect(resumed).toBe(0)
    sink.drain()
    out.pump()
    expect(resumed).toBe(1)
  })

  it('drops what a hung-up exchange still holds', () => {
    const out = createRtcOutbox({ budget: 1, schedule: () => 'timer', cancel: () => undefined })
    const sink = channel()
    out.send(sink, 'x1', ['h', 'c1', 'c2'])
    out.drop('x1')
    sink.drain()
    out.pump()
    expect(sink.sent).toEqual(['h'])
    expect(out.queued('x1')).toBe(0)
  })

  it('looks again on its own when the channels were full', () => {
    const timers = manual()
    const out = createRtcOutbox({ budget: 1, ...timers })
    const sink = channel()
    out.send(sink, 'x1', ['p1', 'p2'])
    sink.drain()
    timers.fire()
    expect(sink.sent).toEqual(['p1', 'p2'])
  })

  it('forgets a channel that throws, and keeps serving the others', () => {
    const out = createRtcOutbox({ budget: 1000 })
    const good = channel()
    const gone: OutboxSink = {
      send: () => {
        throw new Error('closed')
      },
      bufferedAmount: 0
    }
    out.send(gone, 's1', ['a', 'b'])
    out.send(good, 'link', 'pong')
    expect(good.sent).toEqual(['pong'])
    expect(out.queued('s1')).toBe(0)
  })

  it('does not let a terminal pouring out small messages starve a snapshot', () => {
    const out = createRtcOutbox({ budget: 1, urgent: 10, schedule: () => 'timer', cancel: () => undefined })
    const sink = channel()
    out.send(sink, 'link', 'L')
    out.send(sink, 'x1', ['S'.repeat(40), 'S'.repeat(40)])
    for (let i = 0; i < 10; i += 1) out.send(sink, 's1', 'echo')
    for (let i = 0; i < 4; i += 1) {
      sink.drain()
      out.pump()
    }
    expect(sink.sent.slice(1)).toContain('S'.repeat(40))
  })

  it('stops counting a channel that closed, and drops its lanes', () => {
    const out = createRtcOutbox({ budget: 10, schedule: () => 'timer', cancel: () => undefined })
    const stuck = channel()
    const live = channel()
    out.send(stuck, 's1', ['x'.repeat(20), 'more'])
    out.send(live, 'link', 'pong')
    expect(live.sent).toEqual([])
    out.forget(stuck)
    expect(live.sent).toEqual(['pong'])
    expect(out.queued('s1')).toBe(0)
  })

  it('sends nothing once closed', () => {
    const out = createRtcOutbox()
    const sink = channel()
    out.close()
    out.send(sink, 'link', 'pong')
    expect(sink.sent).toEqual([])
  })
})
