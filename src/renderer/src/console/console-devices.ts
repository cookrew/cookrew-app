/**
 * THE CONSOLE'S MACHINES (0.6.0): the Devices level, with no machine in scope.
 *
 * BEFORE THE GATE the page knows what the registry knows: each machine's
 * name, its platform and whether it holds its line. Nothing from inside any
 * machine is asked for, kept or drawn.
 *
 * PAST THE GATE each machine that can be read is asked for its own summary
 * (`/api/fleet`), at its own address on the relay, with this browser's own
 * key for that machine (relay-machine-call.ts enters its door with the pass
 * when it holds none). One question out per machine, asked again every few
 * seconds WHILE THE LEVEL IS ON SCREEN and at no other time: each question is
 * an exchange through the relay, and a page inside one machine has no use for
 * the others' summaries.
 *
 * A MACHINE THAT CANNOT BE READ SAYS THE ONE THING TO DO, and is not entered:
 * off its line, on a build older than this console speaks to, or refusing
 * this browser in its own words.
 */
import type { AccountMachine, AccountMachines } from '../../../shared/zoom-fleet'
import type { FleetSnapshot } from '../../../shared/fleet'
import { composeFleet, snapshotOf, type ZoomCounts } from '../zoom/fleet-compose'
import type { MachineBlock } from '../relay-machine-call'

/** A machine's own sentence is shown on the console's page: as its own, and no longer than this. */
const MACHINE_WORDS_MAX = 160

/** The first build that answers at api.cookrew.dev/api/m and lets the console's origin in. */
export const MIN_MACHINE_VERSION = '0.6.0'
export const ACCOUNT_EVERY_MS = 60_000
export const SUMMARY_EVERY_MS = 5_000
/** The registry said the session was over: the session renews, and the list is asked for again this soon. */
export const REASK_AFTER_REFUSAL_MS = 5_000

export const DEVICES_COPY = {
  outdated: (name: string): string => `Update Cookrew on ${name}.`,
  offline: (name: string): string => `Open Cookrew on ${name}.`,
  silent: (name: string): string => `${name} is not answering.`,
  reproof: (name: string): string => `${name} did not take this browser’s pass. Sign out and in to prove it’s you again.`,
  says: (name: string, words: string): string => `${name} says: ${words.slice(0, MACHINE_WORDS_MAX)}`,
  noKey: 'This browser has no key for Cookrew. Sign out and in again.',
  unreachable: 'Cookrew’s registry is not answering. What is shown may be out of date.'
} as const

/**
 * locked    before the gate: a name and nothing else
 * offline   not on its line
 * outdated  a build this console cannot talk to
 * blocked   asked, and it did not let this browser in
 * reading   asked, not yet answered
 * live      its own summary is on screen
 */
export type MachineStanding = 'locked' | 'offline' | 'outdated' | 'blocked' | 'reading' | 'live'

export interface ConsoleWorkspace {
  readonly id: string
  readonly name: string
  readonly icon: string | null
  readonly agents: number
  readonly waiting: number
  readonly working: number
}

export interface ConsoleMachine {
  readonly id: string
  readonly name: string
  readonly os: string | null
  readonly online: boolean
  readonly lastSeenAt: number | null
  readonly standing: MachineStanding
  /** The one thing to do about a machine that cannot be read; null otherwise. */
  readonly say: string | null
  readonly workspaces: readonly ConsoleWorkspace[]
  readonly counts: ZoomCounts | null
}

export interface ConsoleDevicesState {
  readonly status: 'loading' | 'ready' | 'failed'
  readonly machines: readonly ConsoleMachine[]
  readonly error: string | null
}

export interface DevicesDeps {
  /** The account's machines, from the registry. */
  readonly account: () => Promise<AccountMachines>
  /** One machine's own summary, or null. */
  readonly fleetOf: (machineId: string) => Promise<unknown | null>
  /** What stood in the way the last time that machine was asked. */
  readonly why: (machineId: string) => MachineBlock | null
  readonly gateOpen: () => boolean
  /** A machine turned the pass away: the gate looks at whether it still holds one. Never clears it. */
  readonly onReproof: () => void
  /** The registry says the session is over. */
  readonly onSignedOut: () => void
}

export interface ConsoleDevices {
  get(): ConsoleDevicesState
  subscribe(listener: () => void): () => void
  /** Signed in: know the account's machines, and keep knowing. Returns its stop. */
  start(): () => void
  /** The level is on screen: read each machine's own summary, and keep reading. Returns its stop. */
  watch(): () => void
  /** The gate opened or closed. */
  gateChanged(): void
}

const triple = (version: string | null): readonly [number, number, number] | null => {
  // A pre-release or build suffix does not change which protocol a build speaks.
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version ?? '')
  return parts === null ? null : [Number(parts[1]), Number(parts[2]), Number(parts[3])]
}

const MIN_TRIPLE = triple(MIN_MACHINE_VERSION) ?? [0, 0, 0]

/** Older than the first build this console speaks to. A version it cannot read is not taken for a new one. */
const outdated = (version: string | null): boolean => {
  const have = triple(version)
  if (have === null) return true
  for (let at = 0; at < 3; at += 1) if (have[at] !== MIN_TRIPLE[at]) return have[at] < MIN_TRIPLE[at]
  return false
}

/** Where one machine stands, and what it says about itself when it cannot be read. */
export function standingOf(row: AccountMachine, at: { open: boolean; read: boolean; block: MachineBlock | null }): { standing: MachineStanding; say: string | null } {
  if (!row.online) return { standing: 'offline', say: DEVICES_COPY.offline(row.name) }
  if (outdated(row.appVersion)) return { standing: 'outdated', say: DEVICES_COPY.outdated(row.name) }
  if (!at.open) return { standing: 'locked', say: null }
  if (at.read) return { standing: 'live', say: null }
  if (at.block?.kind === 'refused') return { standing: 'blocked', say: DEVICES_COPY.says(row.name, at.block.message) }
  if (at.block?.kind === 'offline') return { standing: 'blocked', say: DEVICES_COPY.silent(row.name) }
  // One machine not taking the pass is about that machine: the gate, and the others, stand.
  if (at.block?.kind === 'needs-proof') return { standing: 'blocked', say: DEVICES_COPY.reproof(row.name) }
  if (at.block?.kind === 'no-device') return { standing: 'blocked', say: DEVICES_COPY.noKey }
  return { standing: 'reading', say: null }
}

const readable = (row: AccountMachine): boolean => row.online && !outdated(row.appVersion)

export function createConsoleDevices(deps: DevicesDeps): ConsoleDevices {
  const listeners = new Set<() => void>()
  let rows: readonly AccountMachine[] = []
  let answered = false
  let error: string | null = null
  let snapshots: Readonly<Record<string, FleetSnapshot>> = {}
  let state: ConsoleDevicesState = { status: 'loading', machines: [], error: null }
  let running = 0
  let watching = 0
  let accountTimer: ReturnType<typeof setInterval> | null = null
  let summaryTimer: ReturnType<typeof setInterval> | null = null
  let reaskTimer: ReturnType<typeof setTimeout> | null = null
  const asking = new Set<string>()
  let reproofAsked = false
  /** Machines that did not take the pass: not asked again until there is a new proof to show them. */
  let passRefused: ReadonlySet<string> = new Set()
  let gateWasOpen = false
  /** Bumped when a SUMMARY read must not be filed any more (the gate closed, the level left the screen). */
  let era = 0
  /** Bumped when the account's list must not be filed any more (signed out). The gate has no say in that. */
  let listEra = 0

  const compose = (): void => {
    const open = deps.gateOpen()
    // Before the gate nothing a row carries beyond its name, platform and line is drawn, whatever the registry sent.
    const bare = rows.map((row) => ({ ...row, workspaces: [] }))
    const drawn = new Map(composeFleet({ snapshot: null, link: 'none', list: null, name: null, account: { ok: true, machines: bare }, remote: open ? snapshots : {} }).map((machine) => [machine.id, machine]))
    const machines = bare.map((row): ConsoleMachine => {
      const read = open && snapshots[row.id] !== undefined && readable(row)
      const { standing, say } = standingOf(row, { open, read, block: open ? deps.why(row.id) : null })
      const machine = drawn.get(row.id)
      const live = standing === 'live' && machine !== undefined
      return {
        id: row.id,
        // The registry's name for it, always: a machine does not get to rename itself on this page.
        name: row.name,
        os: row.profile?.os ?? null,
        online: row.online,
        lastSeenAt: row.lastSeenAt,
        standing,
        say,
        workspaces: live
          ? machine.workspaces.map((w) => ({ id: w.id, name: w.name, icon: w.icon, agents: w.agents.length, waiting: w.counts?.waiting ?? 0, working: w.counts?.working ?? 0 }))
          : [],
        counts: live ? machine.counts : null
      }
    })
    const status = answered ? 'ready' : error !== null ? 'failed' : 'loading'
    const next: ConsoleDevicesState = { status, machines, error }
    if (JSON.stringify(next) === JSON.stringify(state)) return
    state = next
    for (const listener of listeners) listener()
  }

  const askAccount = async (): Promise<void> => {
    const mine = listEra
    const answer = await deps.account().catch((): AccountMachines => ({ ok: false, reason: 'failed' }))
    if (mine !== listEra || running === 0) return
    if (answer.ok) {
      rows = answer.machines
      answered = true
      error = null
      const known = new Set(rows.map((row) => row.id))
      snapshots = Object.fromEntries(Object.entries(snapshots).filter(([id]) => known.has(id)))
      compose()
      return void askSummaries()
    }
    error = DEVICES_COPY.unreachable
    compose()
    if (answer.reason !== 'signed-out') return
    // The session's keeper renews it, or learns the sign-in is over (and this is stopped). Renewed,
    // the list is there for the asking: asked again soon, not at the next minute.
    deps.onSignedOut()
    if (reaskTimer === null) {
      reaskTimer = setTimeout(() => {
        reaskTimer = null
        void askAccount()
      }, REASK_AFTER_REFUSAL_MS)
    }
  }

  const askOne = async (id: string): Promise<void> => {
    if (asking.has(id)) return
    const mine = era
    asking.add(id)
    try {
      const read = snapshotOf(await deps.fleetOf(id).catch(() => null))
      if (mine !== era) return
      if (read !== null) snapshots = { ...snapshots, [id]: read }
      else if (snapshots[id] !== undefined) snapshots = Object.fromEntries(Object.entries(snapshots).filter(([held]) => held !== id))
      if (read === null && deps.why(id)?.kind === 'needs-proof') {
        // Not asked again with the same pass: each ask is its door, through the relay.
        passRefused = new Set([...passRefused, id])
        if (!reproofAsked) {
          reproofAsked = true
          deps.onReproof()
        }
      }
      compose()
    } finally {
      if (mine === era) asking.delete(id)
    }
  }

  const askSummaries = async (): Promise<void> => {
    if (running === 0 || watching === 0 || !deps.gateOpen()) return
    await Promise.all(rows.filter((row) => readable(row) && !passRefused.has(row.id)).map((row) => askOne(row.id)))
  }

  const forgetInside = (): void => {
    era += 1
    asking.clear()
    snapshots = {}
  }

  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    start: () => {
      running += 1
      if (running === 1) {
        gateWasOpen = deps.gateOpen()
        void askAccount()
        accountTimer = setInterval(() => void askAccount(), ACCOUNT_EVERY_MS)
      }
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        running -= 1
        if (running > 0) return
        if (accountTimer !== null) clearInterval(accountTimer)
        accountTimer = null
        if (reaskTimer !== null) clearTimeout(reaskTimer)
        reaskTimer = null
        listEra += 1
        era += 1
        asking.clear()
      }
    },
    watch: () => {
      watching += 1
      if (watching === 1) {
        void askSummaries()
        summaryTimer = setInterval(() => void askSummaries(), SUMMARY_EVERY_MS)
      }
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        watching -= 1
        if (watching > 0) return
        if (summaryTimer !== null) clearInterval(summaryTimer)
        summaryTimer = null
        // Answers still out belong to a level nobody is looking at.
        era += 1
        asking.clear()
      }
    },
    gateChanged: () => {
      const open = deps.gateOpen()
      // A NEW PROOF (closed, then open) is a reason to ask everyone again. The gate saying once
      // more that it is open is not: reset on that, one machine refusing the pass would be asked,
      // refuse, have the gate look, and be asked again, as fast as the relay answers.
      if (open && !gateWasOpen) {
        reproofAsked = false
        passRefused = new Set()
      }
      if (!open) forgetInside()
      const changed = open !== gateWasOpen
      gateWasOpen = open
      compose()
      if (changed) void askSummaries()
    }
  }
}
