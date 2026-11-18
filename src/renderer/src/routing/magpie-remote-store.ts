import type { CookrewApi } from '../api'
import type { MagpieRemoteList } from '../../../shared/remote-magpie'

/**
 * YOUR COMPUTERS, OUTSIDE REACT (DevicesGuide.tsx). The guide is drawn in the
 * first run, in Launch settings and in the Routing panel, and each of those can
 * close while a connect is on its way: asking another computer for a key goes
 * over the relay and can take seconds. So the answer lands here, one store per
 * bridge, and every mount reads the same state.
 *
 * One try per computer at a time. A failure stays on screen, beside that
 * computer, until a try for it works. The newest read that answered wins.
 */

export type MagpieRemoteBridge = Partial<Pick<CookrewApi, 'magpieRemoteList' | 'magpieRemoteConnect' | 'magpieRemoteDisconnect'>>

export interface MagpieRemoteState {
  readonly list: MagpieRemoteList | null
  readonly readProblem: string | null
  /** Computers with a connect or disconnect in flight. */
  readonly busy: readonly string[]
  /** What the last try for each computer said, until one works. */
  readonly problems: Readonly<Record<string, string>>
}

export interface MagpieRemoteStore {
  getSnapshot(): MagpieRemoteState
  subscribe(listener: () => void): () => void
  read(): Promise<void>
  connect(peer: string, name: string): Promise<void>
  disconnect(peer: string): Promise<void>
}

const EMPTY: MagpieRemoteState = { list: null, readProblem: null, busy: [], problems: {} }
const UNAVAILABLE = 'Your other computers are listed in the desktop app.'
const FAILED = 'That did not go through. Try again.'

const call = <T>(send: () => Promise<T>): Promise<T> => new Promise<T>((resolve) => resolve(send()))

const whyOf = (answer: unknown): string | null => {
  const a = answer as { ok?: unknown; why?: unknown; reason?: unknown } | null | undefined
  if (a?.ok === true) return null
  return typeof a?.why === 'string' && a.why ? a.why : typeof a?.reason === 'string' && a.reason ? a.reason : FAILED
}

const isList = (value: unknown): value is MagpieRemoteList => {
  const v = value as Partial<MagpieRemoteList> | null | undefined
  return typeof v?.signedIn === 'boolean' && Array.isArray(v.desktops) && typeof v.sealed === 'boolean'
}

export function createMagpieRemoteStore(bridge: MagpieRemoteBridge): MagpieRemoteStore {
  let state = EMPTY
  let started = 0
  let settled = 0
  const listeners = new Set<() => void>()
  const set = (next: Partial<MagpieRemoteState>): void => {
    state = { ...state, ...next }
    listeners.forEach((l) => l())
  }

  const read = (): Promise<void> => {
    const send = bridge.magpieRemoteList
    if (typeof send !== 'function') {
      set({ readProblem: UNAVAILABLE })
      return Promise.resolve()
    }
    const sequence = ++started
    const land = (answer: unknown): void => {
      if (sequence <= settled) return
      settled = sequence
      if (isList(answer)) set({ list: answer, readProblem: null })
      else set({ readProblem: whyOf(answer) ?? FAILED })
    }
    return call(() => send()).then(land, () => land(null))
  }

  const act = (peer: string, send: (() => Promise<unknown>) | null): Promise<void> => {
    if (state.busy.includes(peer)) return Promise.resolve()
    if (send === null) {
      set({ problems: { ...state.problems, [peer]: UNAVAILABLE } })
      return Promise.resolve()
    }
    set({ busy: [...state.busy, peer] })
    const settle = (why: string | null): void => {
      const { [peer]: _gone, ...rest } = state.problems
      set({ busy: state.busy.filter((p) => p !== peer), problems: why === null ? rest : { ...rest, [peer]: why } })
      void read()
    }
    return call(send).then(
      (answer) => settle(whyOf(answer)),
      () => settle(FAILED)
    )
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    read,
    connect: (peer, name) => {
      const send = bridge.magpieRemoteConnect
      return act(peer, typeof send === 'function' ? () => send(peer, name) : null)
    },
    disconnect: (peer) => {
      const send = bridge.magpieRemoteDisconnect
      return act(peer, typeof send === 'function' ? () => send(peer) : null)
    }
  }
}

const stores = new WeakMap<object, MagpieRemoteStore>()

/** One store per bridge: a remounted guide finds what the closed one was waiting for. */
export function magpieRemoteStoreFor(bridge: MagpieRemoteBridge): MagpieRemoteStore {
  const known = stores.get(bridge)
  if (known) return known
  const store = createMagpieRemoteStore(bridge)
  stores.set(bridge, store)
  return store
}
