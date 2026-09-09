import { describe, expect, it } from 'vitest'
import {
  acceptSeal,
  generateSealKeyPair,
  sameSecret,
  startSeal
} from '../src/shared/relay-seal'

/**
 * THE SEAL.
 *
 * Two claims decide whether the relay may carry real conversations: the relay
 * cannot read them, and it cannot stand in the middle. A third decides whether
 * anyone will accept it: it must not cost the stream anything.
 */

const DOOR = '@drej/cookrew-alpha'

function handshake(info = DOOR): ReturnType<typeof pair> {
  return pair(info)
}

function pair(info: string) {
  const door = generateSealKeyPair()
  const caller = startSeal(door.publicKey, info)
  const { accept, channel: doorSide } = acceptSeal(door.privateKey, caller.hello, info)
  return { door, callerSide: caller.finish(accept), doorSide }
}

describe('a sealed channel', () => {
  it('carries a message in each direction', () => {
    const { callerSide, doorSide } = handshake()
    const asked = callerSide.tx.seal('{"prompt":"17 * 3"}')
    expect(doorSide.rx.open(asked, 0)).toBe('{"prompt":"17 * 3"}')

    const answered = doorSide.tx.seal('event: data\ndata: "51"\n\n')
    expect(callerSide.rx.open(answered, 0)).toBe('event: data\ndata: "51"\n\n')
  })

  it('uses a different key each way — a frame cannot be echoed back', () => {
    const { callerSide, doorSide } = handshake()
    const asked = callerSide.tx.seal('secret')
    // The caller's own receive channel must NOT open what the caller sent.
    expect(callerSide.rx.open(asked, 0)).toBeNull()
    expect(doorSide.rx.open(asked, 0)).toBe('secret')
  })

  it('both ends really did agree', () => {
    const { callerSide, doorSide } = handshake()
    expect(sameSecret(callerSide, doorSide)).toBe(true)
  })
})

describe('what the relay cannot do', () => {
  it('cannot read what it carries', () => {
    const { callerSide } = handshake()
    const sealed = callerSide.tx.seal('the prompt nobody else should see')
    expect(sealed).not.toContain('prompt')
    expect(Buffer.from(sealed, 'base64url').toString('utf8')).not.toContain('nobody')
  })

  it('cannot stand in the middle: a substituted door key opens nothing', () => {
    const realDoor = generateSealKeyPair()
    const relay = generateSealKeyPair()
    // The relay hands the caller ITS key instead of the door's.
    const caller = startSeal(relay.publicKey, DOOR)
    // The real door answers the hello it was passed.
    const { accept, channel: doorSide } = acceptSeal(realDoor.privateKey, caller.hello, DOOR)
    const callerSide = caller.finish(accept)

    // Neither side can read the other: the impostor is discovered at the first
    // frame rather than succeeding silently.
    expect(doorSide.rx.open(callerSide.tx.seal('hello'), 0)).toBeNull()
    expect(callerSide.rx.open(doorSide.tx.seal('hello'), 0)).toBeNull()
  })

  it('cannot alter a frame without the tag failing', () => {
    const { callerSide, doorSide } = handshake()
    const sealed = callerSide.tx.seal('pay 2.50')
    const raw = Buffer.from(sealed, 'base64url')
    raw[0] ^= 0x01
    expect(doorSide.rx.open(raw.toString('base64url'), 0)).toBeNull()
  })

  it('cannot replay or reorder — the nonce IS the sequence', () => {
    const { callerSide, doorSide } = handshake()
    const first = callerSide.tx.seal('one')
    const second = callerSide.tx.seal('two')
    expect(doorSide.rx.open(first, 0)).toBe('one')
    // Replaying the first at the next position fails; so does taking them out
    // of order. Neither needs a second mechanism — it falls out of the counter.
    expect(doorSide.rx.open(first, 1)).toBeNull()
    expect(doorSide.rx.open(second, 0)).toBeNull()
    expect(doorSide.rx.open(second, 1)).toBe('two')
  })

  it('a channel for one door does not open a frame meant for another', () => {
    // The keys are bound to the door's name, so a secret negotiated for one
    // cannot be replayed at another.
    const door = generateSealKeyPair()
    const caller = startSeal(door.publicKey, '@drej/alpha')
    const answer = acceptSeal(door.privateKey, caller.hello, '@drej/beta')
    const callerSide = caller.finish(answer.accept)
    expect(answer.channel.rx.open(callerSide.tx.seal('x'), 0)).toBeNull()
  })
})

describe('forward secrecy', () => {
  it('two sessions with the same door share no key', () => {
    const door = generateSealKeyPair()
    const one = startSeal(door.publicKey, DOOR)
    const first = acceptSeal(door.privateKey, one.hello, DOOR)
    const two = startSeal(door.publicKey, DOOR)
    const second = acceptSeal(door.privateKey, two.hello, DOOR)

    const sealedByOne = one.finish(first.accept).tx.seal('yesterday')
    // The door's long-term key is the SAME in both, yet the second session
    // cannot read the first: today's theft does not open yesterday's words.
    expect(second.channel.rx.open(sealedByOne, 0)).toBeNull()
  })
})

describe('it must not cost the stream', () => {
  it('adds a fixed 16-byte tag and nothing else per frame', () => {
    const { callerSide } = handshake()
    for (const size of [16, 256, 4096]) {
      const plain = 'x'.repeat(size)
      const sealed = Buffer.from(callerSide.tx.seal(plain), 'base64url')
      // No nonce on the wire, no padding, no length prefix — just the tag.
      expect(sealed.length, `${size}`).toBe(size + 16)
    }
  })

  it('seals a terminal’s worth of bursts far faster than they arrive', () => {
    const { callerSide, doorSide } = handshake()
    // A busy agent emits small ANSI bursts. 20k of them is minutes of terminal.
    const burst = '[2m── a line of agent output with escapes [0m\r\n'
    const rounds = 20_000

    const started = process.hrtime.bigint()
    for (let i = 0; i < rounds; i += 1) {
      const sealed = doorSide.tx.seal(burst)
      const opened = callerSide.rx.open(sealed, i)
      if (opened !== burst) throw new Error('round trip failed')
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6

    // The claim is not "fast enough on this machine" — it is that the seal is
    // nowhere near the stream. A terminal produces tens of bursts a second; if
    // 20k round trips take under a second, sealing costs microseconds each and
    // cannot be what a person feels.
    expect(ms).toBeLessThan(1000)
    const perBurstUs = (ms * 1000) / rounds
    expect(perBurstUs).toBeLessThan(50)
  })

  it('the handshake happens once, and costs one exchange', () => {
    // No round trip per frame is the property that matters; the handshake is
    // two public values and both are already in flight with the first request.
    const door = generateSealKeyPair()
    const started = process.hrtime.bigint()
    for (let i = 0; i < 200; i += 1) {
      const caller = startSeal(door.publicKey, DOOR)
      const answer = acceptSeal(door.privateKey, caller.hello, DOOR)
      caller.finish(answer.accept)
    }
    const msEach = Number(process.hrtime.bigint() - started) / 1e6 / 200
    expect(msEach).toBeLessThan(10)
  })
})
