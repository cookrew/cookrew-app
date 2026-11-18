import type { CookrewApi } from '../api'
import { SHARE_COPY } from '../../../shared/account-guide-copy'
import type { SharedKey, ShareWhere } from '../../../shared/share-devices'

/**
 * SHARE WITH MY DEVICES, OUTSIDE REACT.
 *
 * The Routing panel unmounts when it closes, and an answer from main can
 * arrive after that: the one-time key from "Make a key", or a revoke. Held in
 * component state, those answers landed on nothing and the key was lost for
 * good. So the section's state lives here, one store per bridge, and the
 * component only reads it (useSyncExternalStore).
 *
 * Reads can answer out of order. The newest read that answered wins, and a
 * read that began before a key was made or revoked is not allowed to undo it.
 *
 * Failures stay on screen until what failed is answered: a read problem until
 * a read works, an issue problem until an issue works, a revoke problem until
 * that key is revoked or no longer listed. One kind never clears another.
 */

export interface Issued {
  readonly id: string
  readonly key: string
  readonly device: string
}

export type ShareProblem =
  | { readonly from: 'read'; readonly text: string }
  | { readonly from: 'issue'; readonly text: string }
  | { readonly from: 'revoke'; readonly id: string; readonly text: string }

export interface ShareDevicesState {
  readonly keys: readonly SharedKey[]
  readonly where: ShareWhere | null
  readonly problems: readonly ShareProblem[]
  /** The key from "Make a key", held until Done (or until that key is revoked). */
  readonly issued: Issued | null
  readonly issuing: boolean
  readonly revoking: readonly string[]
}

export type ShareBridge = Partial<Pick<CookrewApi, 'routeShareList' | 'routeShareIssue' | 'routeShareRevoke'>>

export interface ShareDevicesStore {
  getSnapshot: () => ShareDevicesState
  subscribe: (listener: () => void) => () => void
  read: () => Promise<void>
  issue: (device: string, dailyUsd: number) => Promise<void>
  revoke: (id: string) => Promise<void>
  done: () => void
}

const EMPTY: ShareDevicesState = { keys: [], where: null, problems: [], issued: null, issuing: false, revoking: [] }

type Failed = { ok?: unknown; why?: unknown; reason?: unknown } | null | undefined

const problemOf = (answer: Failed): string => {
  if (typeof answer?.why === 'string' && answer.why) return answer.why
  if (typeof answer?.reason === 'string' && answer.reason) return answer.reason
  return SHARE_COPY.UNAVAILABLE
}

/** A bridge call that throws before it returns a promise is a failure like any other. */
const call = <T>(send: () => Promise<T>): Promise<T> => new Promise<T>((resolve) => resolve(send()))

const sameSlot = (a: ShareProblem, b: ShareProblem): boolean => a.from === b.from && (a.from !== 'revoke' || (b.from === 'revoke' && a.id === b.id))

const withProblem = (problems: readonly ShareProblem[], problem: ShareProblem): readonly ShareProblem[] => [...problems.filter((p) => !sameSlot(p, problem)), problem]

const isWhere = (value: unknown): value is ShareWhere => {
  const where = value as Partial<ShareWhere> | null | undefined
  return typeof where?.onNetwork === 'boolean' && Array.isArray(where.urls)
}

const isKey = (value: unknown): value is SharedKey => {
  const k = value as Partial<SharedKey> | null | undefined
  return typeof k?.id === 'string' && typeof k.device === 'string'
}

type Listed = { ok: true; keys: readonly SharedKey[]; where: ShareWhere } | { ok: false; text: string }

function listedFrom(answer: unknown): Listed {
  const a = answer as { ok?: unknown; keys?: unknown; where?: unknown } | null | undefined
  if (a?.ok === true && Array.isArray(a.keys) && a.keys.every(isKey) && isWhere(a.where)) return { ok: true, keys: a.keys, where: a.where }
  return { ok: false, text: a?.ok === true ? SHARE_COPY.UNAVAILABLE : problemOf(a as Failed) }
}

type Made = { ok: true; issued: Issued; shared: SharedKey } | { ok: false; text: string }

function madeFrom(answer: unknown): Made {
  const a = answer as { ok?: unknown; key?: unknown; shared?: unknown } | null | undefined
  if (a?.ok === true && typeof a.key === 'string' && a.key && isKey(a.shared)) {
    return { ok: true, shared: a.shared, issued: { id: a.shared.id, key: a.key, device: a.shared.device } }
  }
  return { ok: false, text: a?.ok === true ? SHARE_COPY.UNAVAILABLE : problemOf(a as Failed) }
}

export function createShareDevicesStore(bridge: ShareBridge): ShareDevicesStore {
  let state = EMPTY
  const listeners = new Set<() => void>()
  /** The last read handed out, the newest read whose answer was applied, and the reads that began before a change landed. */
  let started = 0
  let settled = 0
  let floor = 0

  const set = (next: Partial<ShareDevicesState>): void => {
    state = { ...state, ...next }
    listeners.forEach((listener) => listener())
  }
  const fail = (problem: ShareProblem, next: Partial<ShareDevicesState> = {}): void => set({ ...next, problems: withProblem(state.problems, problem) })

  const applyList = (sequence: number, answer: unknown): void => {
    if (sequence <= settled || sequence <= floor) return
    settled = sequence
    const listed = listedFrom(answer)
    if (!listed.ok) return fail({ from: 'read', text: listed.text })
    const listedIds = new Set(listed.keys.map((k) => k.id))
    // A revoke that failed for a key no longer listed has nothing left to report.
    const problems = state.problems.filter((p) => p.from === 'issue' || (p.from === 'revoke' && listedIds.has(p.id)))
    set({ keys: listed.keys, where: listed.where, problems })
  }

  const read = (): Promise<void> => {
    const list = bridge.routeShareList
    if (typeof list !== 'function') return Promise.resolve()
    const sequence = ++started
    return call(() => list()).then(
      (answer) => applyList(sequence, answer),
      () => applyList(sequence, null)
    )
  }

  /** A key was made or revoked: no read that began before this may answer for the list. */
  const changed = (next: Partial<ShareDevicesState>): void => {
    floor = started
    set(next)
    void read()
  }

  const issue = (device: string, dailyUsd: number): Promise<void> => {
    // One key at a time: a second answer would replace a key nobody has copied yet.
    if (state.issuing || state.issued) return Promise.resolve()
    const send = bridge.routeShareIssue
    if (typeof send !== 'function') {
      fail({ from: 'issue', text: SHARE_COPY.UNAVAILABLE })
      return Promise.resolve()
    }
    set({ issuing: true })
    return call(() => send({ device, dailyUsd })).then(
      (answer) => {
        const made = madeFrom(answer)
        if (!made.ok) return fail({ from: 'issue', text: made.text }, { issuing: false })
        const keys = [...state.keys.filter((k) => k.id !== made.shared.id), made.shared]
        changed({ issuing: false, issued: made.issued, keys, problems: state.problems.filter((p) => p.from !== 'issue') })
      },
      () => fail({ from: 'issue', text: SHARE_COPY.UNAVAILABLE }, { issuing: false })
    )
  }

  const revoke = (id: string): Promise<void> => {
    if (state.revoking.includes(id)) return Promise.resolve()
    const send = bridge.routeShareRevoke
    if (typeof send !== 'function') {
      fail({ from: 'revoke', id, text: SHARE_COPY.UNAVAILABLE })
      return Promise.resolve()
    }
    set({ revoking: [...state.revoking, id] })
    const settle = (): readonly string[] => state.revoking.filter((value) => value !== id)
    return call(() => send(id)).then(
      (answer) => {
        const a = answer as Failed
        if (a?.ok !== true) return fail({ from: 'revoke', id, text: problemOf(a) }, { revoking: settle() })
        changed({
          revoking: settle(),
          keys: state.keys.filter((k) => k.id !== id),
          issued: state.issued?.id === id ? null : state.issued,
          problems: state.problems.filter((p) => !(p.from === 'revoke' && p.id === id))
        })
      },
      () => fail({ from: 'revoke', id, text: SHARE_COPY.UNAVAILABLE }, { revoking: settle() })
    )
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    read,
    issue,
    revoke,
    done: () => set({ issued: null })
  }
}

const stores = new WeakMap<object, ShareDevicesStore>()

/** One store per bridge: a remounted panel finds what the closed one was waiting for. */
export function shareDevicesStoreFor(bridge: ShareBridge): ShareDevicesStore {
  const known = stores.get(bridge)
  if (known) return known
  const store = createShareDevicesStore(bridge)
  stores.set(bridge, store)
  return store
}

/** Every distinct failure still standing, in the order they happened. */
export function problemText(state: ShareDevicesState): string | null {
  const texts = [...new Set(state.problems.map((p) => p.text))]
  return texts.length > 0 ? texts.join(' ') : null
}
