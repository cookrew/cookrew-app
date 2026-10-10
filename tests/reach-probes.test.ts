// THREE KNOCKS THAT ARE NOT A FETCH, each answering what it did and how long it took.
import { describe, expect, it } from 'vitest'
import {
  PROBE_DEADLINE_MS,
  probeImage,
  probeOpaque,
  probeReach,
  probeSocket,
  socketUrl,
  type ImageLike,
  type SocketLike
} from '../src/renderer/src/path/reach-probes'

const ORIGIN = 'https://192-168-2-40.e03994f9-138d-80ff-9377-475cc59142b4.d.cookrew.dev:8643'
const NAME = '192-168-2-40.e03994f9-138d-80ff-9377-475cc59142b4.d.cookrew.dev:8643'

const clock = (steps: number[]) => {
  let i = 0
  return () => steps[Math.min(i++, steps.length - 1)]
}

const fakeSocket = () => {
  const made: { url: string; socket: SocketLike; closed: number }[] = []
  const socket = (url: string): SocketLike => {
    const entry = {
      url,
      closed: 0,
      socket: {
        onopen: null,
        onerror: null,
        onclose: null,
        close: () => void (entry.closed += 1)
      } as SocketLike
    }
    made.push(entry)
    return entry.socket
  }
  return { made, socket }
}

describe('probeSocket', () => {
  it('spells the hello socket on the name, and an open is an answer', async () => {
    expect(socketUrl(ORIGIN)).toBe(`wss://${NAME}/api/ws-hello`)
    const { made, socket } = fakeSocket()
    const pending = probeSocket(ORIGIN, { socket, now: clock([0, 37]) })
    made[0].socket.onopen?.({})
    await expect(pending).resolves.toEqual({ kind: 'socket', name: NAME, outcome: 'answered', ms: 37 })
    expect(made[0].closed).toBe(1)
  })

  it('an error, or a close before any open, is the network saying no', async () => {
    const { made, socket } = fakeSocket()
    const a = probeSocket(ORIGIN, { socket, now: clock([0, 4]) })
    made[0].socket.onerror?.({})
    await expect(a).resolves.toMatchObject({ outcome: 'network', ms: 4 })
    const b = probeSocket(ORIGIN, { socket, now: clock([0, 9]) })
    made[1].socket.onclose?.({})
    await expect(b).resolves.toMatchObject({ outcome: 'network', ms: 9 })
  })

  it('nothing at all by the deadline is a timeout, and the socket is closed', async () => {
    const { made, socket } = fakeSocket()
    const pending = probeSocket(ORIGIN, { socket, now: clock([0, 11]), deadlineMs: 5 })
    await expect(pending).resolves.toMatchObject({ outcome: 'timeout', ms: 11 })
    expect(made[0].closed).toBe(1)
  })

  it('a constructor that throws is a network failure, not a crash', async () => {
    const pending = probeSocket(ORIGIN, {
      socket: () => {
        throw new Error('SecurityError')
      }
    })
    await expect(pending).resolves.toMatchObject({ outcome: 'network' })
  })
})

describe('probeImage', () => {
  it('loads the pixel and an onload is an answer', async () => {
    let image: ImageLike | null = null
    const pending = probeImage(ORIGIN, {
      image: () => (image = { onload: null, onerror: null, src: '' }),
      now: clock([0, 21])
    })
    expect(image!.src.startsWith(`${ORIGIN}/api/pixel?`)).toBe(true)
    image!.onload?.({})
    await expect(pending).resolves.toEqual({ kind: 'image', name: NAME, outcome: 'answered', ms: 21 })
  })
})

describe('probeOpaque', () => {
  it('asks the hello in no-cors mode, and a resolved (opaque) response is an answer', async () => {
    let init: RequestInit | null = null
    const pending = probeOpaque(ORIGIN, {
      fetch: async (_url, i) => {
        init = i
        return {}
      },
      now: clock([0, 15])
    })
    await expect(pending).resolves.toMatchObject({ kind: 'opaque', outcome: 'answered', ms: 15 })
    expect(init!.mode).toBe('no-cors')
    expect(init!.credentials).toBe('omit')
  })

  it('a rejected fetch is the network', async () => {
    await expect(
      probeOpaque(ORIGIN, { fetch: async () => Promise.reject(new TypeError('Load failed')) })
    ).resolves.toMatchObject({ outcome: 'network' })
  })
})

describe('probeReach', () => {
  it('runs all three at once and reports each', async () => {
    const { made, socket } = fakeSocket()
    const pending = probeReach(ORIGIN, {
      socket,
      image: () => {
        const image: ImageLike = { onload: null, onerror: null, src: '' }
        queueMicrotask(() => image.onerror?.({}))
        return image
      },
      fetch: async () => ({}),
      deadlineMs: 5
    })
    made[0].socket.onopen?.({})
    const probes = await pending
    expect(probes.map((probe) => [probe.kind, probe.outcome])).toEqual([
      ['socket', 'answered'],
      ['image', 'network'],
      ['opaque', 'answered']
    ])
  })

  it('has room for a cold lookup of the name', () => {
    expect(PROBE_DEADLINE_MS).toBeGreaterThanOrEqual(2500)
  })
})
