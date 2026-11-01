// AN OFFLINE AGENT TAKES A PROMPT: THE FIRST KEY WAKES IT.
//
// Owner, 2026-11-01: an offline agent could not be prompted. The prompt box and
// the card's reply box type into the agent's terminal, and main only woke an
// agent that THIS run of the app had put to sleep — a ledger kept in memory.
// An agent offline for any other reason (the app restarted since it slept,
// its pane was closed, herdr restarted) had no mirror, and every key typed at
// it vanished without a word. The phone's /raw answered 404 for the same card.
import { describe, expect, it } from 'vitest'
import { AgentWaker, type WakeDeps } from '../src/main/agent-wake'

interface FakeSession {
  writes: string[]
  write: (data: string) => void
}

const session = (): FakeSession => {
  const writes: string[] = []
  return { writes, write: (data) => void writes.push(data) }
}

/** A world of terminals: `live` have a mirror, `known` can be booted, `alive` still have their pane. */
function world(over: Partial<WakeDeps<FakeSession>> & { known?: string[]; alive?: string[]; asleep?: string[] } = {}) {
  const sessions = new Map<string, FakeSession>()
  const booted: string[] = []
  const readied: string[] = []
  const lost: { id: string; chunks: readonly string[] }[] = []
  const pauses: number[] = []
  const asleep = new Set(over.asleep ?? [])
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const deps: WakeDeps<FakeSession> = {
    session: (id) => sessions.get(id),
    isTerminal: (id) => (over.known ?? ['forge']).includes(id),
    paneAlive: (id) => (over.alive ?? []).includes(id),
    boot: (id) => {
      booted.push(id)
      sessions.set(id, session())
      return true
    },
    ready: async () => {
      readied.push('ready')
      await gate
      return true
    },
    sleep: { take: (id) => asleep.delete(id), mark: (id) => void asleep.add(id) },
    pause: async (ms) => void pauses.push(ms),
    lost: (id, chunks) => void lost.push({ id, chunks }),
    ...over
  }
  return { waker: new AgentWaker(deps), sessions, booted, readied, lost, pauses, asleep, release: () => release() }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('AgentWaker — keys for an offline agent', () => {
  it('wakes an agent that is offline though this app never slept it', async () => {
    const w = world()
    expect(w.waker.hold('forge', 'h')).toBe(true)
    expect(w.booted).toEqual(['forge'])
    w.release()
    await settle()
    expect(w.sessions.get('forge')?.writes).toEqual(['h'])
  })

  it('holds every key typed while it boots, and types them in order once it is ready', async () => {
    const w = world()
    w.waker.hold('forge', 'h')
    // The boot is synchronous: the mirror exists from here on, but is not ready.
    expect(w.sessions.get('forge')).toBeDefined()
    expect(w.waker.hold('forge', 'i')).toBe(true)
    expect(w.sessions.get('forge')?.writes).toEqual([])
    w.release()
    await settle()
    expect(w.sessions.get('forge')?.writes).toEqual(['hi'])
    expect(w.booted).toEqual(['forge'])
  })

  it('sends Enter on its own, after a pause, so the words are not taken for a paste', async () => {
    const w = world()
    w.waker.hold('forge', 'fix the tests')
    w.waker.hold('forge', '\r')
    w.release()
    await settle()
    expect(w.sessions.get('forge')?.writes).toEqual(['fix the tests', '\r'])
    expect(w.pauses).toHaveLength(1)
    expect(w.pauses[0]).toBeGreaterThan(0)
  })

  it('splits a batch that ends in Enter (the phone sends words and Enter together)', async () => {
    const w = world()
    w.waker.hold('forge', 'ship it\r')
    w.release()
    await settle()
    expect(w.sessions.get('forge')?.writes).toEqual(['ship it', '\r'])
  })

  it('keeps ESC Enter whole: it is a newline in the box, not a submit', async () => {
    const w = world()
    w.waker.hold('forge', 'a\x1b\r')
    w.release()
    await settle()
    expect(w.sessions.get('forge')?.writes).toEqual(['a\x1b\r'])
  })

  it('lets keys through untouched once the wake is over', async () => {
    const w = world()
    w.waker.hold('forge', 'a')
    w.release()
    await settle()
    expect(w.waker.hold('forge', 'b')).toBe(false)
  })

  it('leaves a running agent alone: the caller writes to it', () => {
    const w = world()
    w.sessions.set('forge', session())
    expect(w.waker.hold('forge', 'x')).toBe(false)
    expect(w.booted).toEqual([])
  })

  it('leaves an id that is no card alone', () => {
    const w = world({ known: [] })
    expect(w.waker.hold('setup-term', 'x')).toBe(false)
    expect(w.booted).toEqual([])
  })

  it('does not wait out a boot when the pane is still alive: only the mirror was missing', async () => {
    const w = world({ alive: ['forge'] })
    const woke = await w.waker.wake('forge')
    expect(woke).toBeDefined()
    expect(w.readied).toEqual([])
  })

  it('says the keys were lost when the agent cannot be started', async () => {
    const w = world({ boot: () => false })
    w.waker.hold('forge', 'hello')
    w.waker.hold('forge', '\r')
    await settle()
    expect(w.lost).toEqual([{ id: 'forge', chunks: ['hello', '\r'] }])
    // Nothing stays queued: the next key tries again.
    expect(w.waker.hold('forge', 'x')).toBe(true)
  })
})

describe('AgentWaker — wake', () => {
  it('shares one boot between two callers', async () => {
    const w = world()
    const a = w.waker.wake('forge')
    const b = w.waker.wake('forge')
    w.release()
    expect(await a).toBe(await b)
    expect(w.booted).toEqual(['forge'])
  })

  it('claims an idle sleep, and puts it back when the boot fails', async () => {
    const ok = world({ asleep: ['forge'] })
    ok.release()
    await ok.waker.wake('forge')
    expect(ok.asleep.has('forge')).toBe(false)

    const failed = world({ asleep: ['forge'], boot: () => false })
    expect(await failed.waker.wake('forge')).toBeUndefined()
    expect(failed.asleep.has('forge')).toBe(true)
  })

  it('does not put an agent to sleep that was never asleep when its boot fails', async () => {
    const w = world({ boot: () => false })
    await w.waker.wake('forge')
    expect(w.asleep.has('forge')).toBe(false)
  })

  it('resolves undefined for an id that is no card', async () => {
    const w = world({ known: [] })
    expect(await w.waker.wake('nobody')).toBeUndefined()
    expect(w.booted).toEqual([])
  })

  it('hands back a running session at once', async () => {
    const w = world()
    const live = session()
    w.sessions.set('forge', live)
    expect(await w.waker.wake('forge')).toBe(live)
    expect(w.booted).toEqual([])
  })
})
