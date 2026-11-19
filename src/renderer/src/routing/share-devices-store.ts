import type { CookrewApi } from '../api'
import { SHARE_COPY } from '../../../shared/account-guide-copy'
import type { PendingKey, SharedKey, ShareWhere } from '../../../shared/share-devices'

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
 *
 * A window that reloads loses even this store, so main keeps what must survive
 * it (share-keys.ts): whether an issue is still running (the store reads again
 * until it is not), the key last made until Done, and every key left behind by
 * a failed or crashed issue, which warns until the owner clears it.
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
  | { readonly from: 'pending'; readonly name: string; readonly text: string }
  | { readonly from: 'done'; readonly text: string }

export interface ShareDevicesState {
  readonly keys: readonly SharedKey[]
  readonly where: ShareWhere | null
  readonly problems: readonly ShareProblem[]
  /** The key from "Make a key", held until Done (or until that key is revoked). */
  readonly issued: Issued | null
  readonly issuing: boolean
  readonly revoking: readonly string[]
  /** Keys left behind by an issue that went wrong: warned of until cleared by hand. */
  readonly pending: readonly PendingKey[]
  /** Left-behind names with a revoke-and-check or a clear in flight. */
  readonly resolving: readonly string[]
}

export type ShareBridge = Partial<Pick<CookrewApi, 'routeShareList' | 'routeShareIssue' | 'routeShareRevoke' | 'routeShareResolve' | 'routeShareClear' | 'routeShareDone'>>

export interface ShareDevicesStore {
  getSnapshot: () => ShareDevicesState
  subscribe: (listener: () => void) => () => void
  read: () => Promise<void>
  issue: (device: string, dailyUsd: number) => Promise<void>
  revoke: (id: string) => Promise<void>
  /** Revoke every key of a left-behind name and check no add of it is still running. */
  resolve: (name: string) => Promise<void>
  /** Clear a left-behind name main says may be cleared. */
  clear: (name: string) => Promise<void>
  done: () => void
}

const EMPTY: ShareDevicesState = { keys: [], where: null, problems: [], issued: null, issuing: false, revoking: [], pending: [], resolving: [] }
/** While main is still making a key (a reloaded window), how often to look again. */
const ISSUING_POLL_MS = 1000

type Failed = { ok?: unknown; why?: unknown; reason?: unknown } | null | undefined

const problemOf = (answer: Failed): string => {
  if (typeof answer?.why === 'string' && answer.why) return answer.why
  if (typeof answer?.reason === 'string' && answer.reason) return answer.reason
  return SHARE_COPY.UNAVAILABLE
}

/** A bridge call that throws before it returns a promise is a failure like any other. */
const call = <T>(send: () => Promise<T>): Promise<T> => new Promise<T>((resolve) => resolve(send()))

const sameSlot = (a: ShareProblem, b: ShareProblem): boolean =>
  a.from === b.from && (a.from !== 'revoke' || (b.from === 'revoke' && a.id === b.id)) && (a.from !== 'pending' || (b.from === 'pending' && a.name === b.name))

const withProblem = (problems: readonly ShareProblem[], problem: ShareProblem): readonly ShareProblem[] => [...problems.filter((p) => !sameSlot(p, problem)), problem]

const isWhere = (value: unknown): value is ShareWhere => {
  const where = value as Partial<ShareWhere> | null | undefined
  return typeof where?.onNetwork === 'boolean' && Array.isArray(where.urls)
}

const isKey = (value: unknown): value is SharedKey => {
  const k = value as Partial<SharedKey> | null | undefined
  return typeof k?.id === 'string' && typeof k.device === 'string'
}

const isPending = (value: unknown): value is PendingKey => {
  const p = value as Partial<PendingKey> | null | undefined
  return typeof p?.name === 'string' && typeof p.device === 'string' && typeof p.clearable === 'boolean'
}

const isIssued = (value: unknown): value is Issued => {
  const h = value as Partial<Issued> | null | undefined
  return typeof h?.id === 'string' && typeof h.key === 'string' && h.key !== '' && typeof h.device === 'string'
}

type Listed =
  | { ok: true; keys: readonly SharedKey[]; where: ShareWhere; pending: readonly PendingKey[]; issuing: boolean; handover: Issued | null }
  | { ok: false; text: string }

/** An older main sends no pending, issuing or handover: absent reads as none; present and malformed is a failure. */
function listedFrom(answer: unknown): Listed {
  const a = answer as { ok?: unknown; keys?: unknown; where?: unknown; pending?: unknown; issuing?: unknown; handover?: unknown } | null | undefined
  const pendingOk = a?.pending === undefined || (Array.isArray(a.pending) && a.pending.every(isPending))
  const handoverOk = a?.handover === undefined || a.handover === null || isIssued(a.handover)
  if (a?.ok === true && Array.isArray(a.keys) && a.keys.every(isKey) && isWhere(a.where) && pendingOk && handoverOk && (a.issuing === undefined || typeof a.issuing === 'boolean')) {
    return { ok: true, keys: a.keys, where: a.where, pending: (a.pending as PendingKey[] | undefined) ?? [], issuing: a.issuing === true, handover: (a.handover as Issued | null | undefined) ?? null }
  }
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

export function createShareDevicesStore(
  bridge: ShareBridge,
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms)
): ShareDevicesStore {
  let state = EMPTY
  /** Keys the owner said Done to here: a read that began before main heard it must not show them again. */
  let doneIds: readonly string[] = []
  let polling = false
  /** An issue this store sent and is waiting on (as against one main reports from before a reload). */
  let issuingHere = false
  let confirming = false
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
    const pendingNames = new Set(listed.pending.map((p) => p.name))
    // A revoke that failed for a key no longer listed has nothing left to report; the same for a cleared name.
    const problems = state.problems.filter((p) => p.from === 'issue' || p.from === 'done' || (p.from === 'revoke' && listedIds.has(p.id)) || (p.from === 'pending' && pendingNames.has(p.name)))
    // Main still holds the key it made for a window that reloaded before it arrived.
    const handover = listed.handover && !doneIds.includes(listed.handover.id) && listedIds.has(listed.handover.id) ? listed.handover : null
    const issued = state.issued ?? handover
    set({ keys: listed.keys, where: listed.where, problems, pending: listed.pending, issued, issuing: issuingHere || listed.issuing })
    // Main is making a key this store did not ask for (the window reloaded mid-issue): look again until it is done.
    if (listed.issuing && !issuingHere && !polling) {
      polling = true
      schedule(() => {
        polling = false
        void read()
      }, ISSUING_POLL_MS)
    }
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
    issuingHere = true
    return call(() => send({ device, dailyUsd })).then(
      (answer) => {
        issuingHere = false
        const made = madeFrom(answer)
        // A failed issue may have left a key behind: the read brings its warning.
        if (!made.ok) {
          fail({ from: 'issue', text: made.text }, { issuing: false })
          return void read()
        }
        const keys = [...state.keys.filter((k) => k.id !== made.shared.id), made.shared]
        changed({ issuing: false, issued: made.issued, keys, problems: state.problems.filter((p) => p.from !== 'issue') })
      },
      () => {
        issuingHere = false
        fail({ from: 'issue', text: SHARE_COPY.UNAVAILABLE }, { issuing: false })
        void read()
      }
    )
  }

  /** Revoke-and-check or clear for one left-behind name: one in flight per name, the answer kept across remounts. */
  const onPending = (name: string, send: ((name: string) => Promise<unknown>) | undefined): Promise<void> => {
    if (state.resolving.includes(name)) return Promise.resolve()
    if (typeof send !== 'function') {
      fail({ from: 'pending', name, text: SHARE_COPY.UNAVAILABLE })
      return Promise.resolve()
    }
    set({ resolving: [...state.resolving, name] })
    const settle = (): readonly string[] => state.resolving.filter((value) => value !== name)
    return call(() => send(name)).then(
      (answer) => {
        const a = answer as Failed
        if (a?.ok !== true) fail({ from: 'pending', name, text: problemOf(a) }, { resolving: settle() })
        else changed({ resolving: settle(), problems: state.problems.filter((p) => !(p.from === 'pending' && p.name === name)) })
      },
      () => fail({ from: 'pending', name, text: SHARE_COPY.UNAVAILABLE }, { resolving: settle() })
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
    resolve: (name) => onPending(name, bridge.routeShareResolve),
    clear: (name) => onPending(name, bridge.routeShareClear),
    done: () => {
      const id = state.issued?.id
      const send = bridge.routeShareDone
      if (id === undefined || confirming) return
      if (typeof send !== 'function') {
        fail({ from: 'done', text: 'Could not record confirmation. Try Done again.' })
        return
      }
      confirming = true
      void call(() => send(id)).then((answer) => {
        confirming = false
        if (answer?.ok !== true) {
          fail({ from: 'done', text: problemOf(answer) })
          return
        }
        doneIds = [...doneIds, id]
        if (state.issued?.id === id) set({ issued: null, problems: state.problems.filter((p) => p.from !== 'done') })
      }, () => {
        confirming = false
        fail({ from: 'done', text: 'Could not record confirmation. Try Done again.' })
      })
    }
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
