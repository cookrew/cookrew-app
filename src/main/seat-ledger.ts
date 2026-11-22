import { execFile } from 'node:child_process'

/**
 * A SEAT KEEPS THE PROFILE IT STARTED UNDER (Seatbelt lane, 2026-11-18).
 *
 * sandbox-exec applies a profile once, at exec, and every descendant inherits
 * it. Nothing tightens a running seat. Two ways that matters:
 *
 *   A LIVE SEAT, when what its profile was built from changes under it: the
 *   owner takes back a lent port, the gateway moves. Its profile is still the
 *   old one. The ledger records each seat's profile digest at spawn, and the
 *   gate asks what a spawn would write NOW.
 *
 *   A LEFTOVER. A seat's child that detaches (nohup, setsid, a double fork)
 *   outlives the seat and the app, still under the profile it started with.
 *   Run for real: a detached child under the profile released builds ship
 *   uploaded through nsurlsessiond to a loopback listener after its parent was
 *   gone (tests/served-fetch-services.test.ts). An update cannot reach it. The
 *   scan below finds processes whose working directory is inside a session
 *   sandbox no live seat owns. BEST EFFORT, said plainly: a process that
 *   changed its directory is not found. The robust half is the other side's
 *   job — nothing new may listen on loopback without its own credential.
 *
 * The gate is what a feature that opens something new on this machine (a
 * remote provider, a tunnel) asks first: closed while any seat is stale or any
 * leftover is found, and closed when the scan cannot run (fail closed).
 */

export interface SeatRecord {
  readonly terminalId: string
  readonly serviceId: string
  /** The seat's resolved sandbox: its own processes work inside it. */
  readonly sandbox: string
  /** profileDigest() of the profile it was spawned under. */
  readonly digest: string
}

export interface Leftover {
  readonly pid: number
  readonly cwd: string
}

export interface SeatGate {
  readonly open: boolean
  /** Live seats whose profile is not what a spawn would write now: respawn them. */
  readonly stale: readonly SeatRecord[]
  /** Processes inside a session sandbox that no live seat owns; null when the scan could not run. */
  readonly leftovers: readonly Leftover[] | null
  /** One line for the owner when closed. */
  readonly why: string | null
}

/** The live seats and the profile each started under. Replaced, never edited in place. */
export class SeatLedger {
  private seats: ReadonlyMap<string, SeatRecord> = new Map()

  record(seat: SeatRecord): void {
    this.seats = new Map([...this.seats, [seat.terminalId, seat]])
  }

  /**
   * Forget a seat. Given the record a spawn made, only THAT record goes: a
   * respawn records the new seat before the old process's exit fires, and the
   * old exit must not take the new record with it.
   */
  forget(terminalId: string, only?: SeatRecord): void {
    const held = this.seats.get(terminalId)
    if (!held || (only && held !== only)) return
    this.seats = new Map([...this.seats].filter(([id]) => id !== terminalId))
  }

  list(): readonly SeatRecord[] {
    return [...this.seats.values()]
  }
}

// lsof and Seatbelt speak POSIX paths, whatever platform these tests run on.
const inside = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(`${root}/`)

/**
 * Parse `lsof -Fpn -d cwd` output into the processes working inside the
 * sessions root but outside every live seat's sandbox.
 */
export function leftoversIn(listing: string, sessionsRoot: string, liveSandboxes: readonly string[]): Leftover[] {
  const found: Leftover[] = []
  let pid: number | null = null
  for (const line of listing.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== null && Number.isInteger(pid)) {
      const cwd = line.slice(1)
      if (inside(sessionsRoot, cwd) && !liveSandboxes.some((sandbox) => inside(sandbox, cwd))) found.push({ pid, cwd })
    }
  }
  return found
}

/** Runs lsof and hands back its stdout, or null when it could not run. Injected for tests. */
export type CwdLister = () => Promise<string | null>

/** Every process of this user, with its working directory, as lsof field output. */
export const lsofCwds: CwdLister = () =>
  new Promise((resolve) => {
    const uid = process.getuid?.()
    if (uid === undefined) return resolve(null)
    execFile('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-u', String(uid), '-Fpn', '-w'], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      // lsof exits 1 when a listed process vanished mid-scan; its output still
      // stands. Anything else (killed on timeout, output past maxBuffer) is a
      // PARTIAL listing, and a partial listing could miss a leftover: no answer.
      if (!error) return resolve(String(stdout))
      const exitedOne = (error as { code?: unknown }).code === 1 && !error.killed
      resolve(exitedOne && stdout ? String(stdout) : null)
    })
  })

export interface GateInput {
  seats: readonly SeatRecord[]
  /** What a spawn would write for this seat now, as a digest; null when it cannot be told (counts as stale). */
  currentDigest: (seat: SeatRecord) => string | null
  /** The resolved sessions root (`~/.cookrew/sessions`). */
  sessionsRoot: string
  listCwds: CwdLister
}

/** Ask before opening anything new on this machine. */
export async function seatGate(input: GateInput): Promise<SeatGate> {
  const stale = input.seats.filter((seat) => input.currentDigest(seat) !== seat.digest)
  const listing = await input.listCwds()
  const leftovers = listing === null ? null : leftoversIn(listing, input.sessionsRoot, input.seats.map((seat) => seat.sandbox))
  const why =
    leftovers === null
      ? 'Could not check for processes left behind by served sessions.'
      : stale.length > 0
        ? `${stale.length} served session(s) run under an older sandbox: restart them first.`
        : leftovers.length > 0
          ? `${leftovers.length} process(es) left behind by served sessions are still running (pid ${leftovers.map((l) => l.pid).join(', ')}).`
          : null
  return { open: why === null, stale, leftovers, why }
}
