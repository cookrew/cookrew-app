/**
 * A NEWER CONSOLE HAS BEEN DEPLOYED.
 *
 * The page is held by its worker (scripts/console-sw.mjs): a tab left open, or
 * a phone's home-screen page that is never really closed, keeps the build it
 * was opened with, and a newer worker waits beside it until every such page is
 * gone. So the page asks the host which build is out there (`/version.json`,
 * served `no-cache`) when it comes back to the front, and compares it with the
 * build it is (a meta tag the build wrote into it).
 *
 * WHEN THEY DIFFER it says so in one line and has the browser fetch the new
 * worker. IT LOADS THE NEW BUILD ONLY WHEN ITS PERSON PRESSES: the waiting
 * worker is asked in, and the page loads again once that worker has taken
 * over. Nothing here reloads by itself, and nothing reloads under a finger.
 *
 * A RELOAD ALONE WOULD CHANGE NOTHING on a page a worker holds: that worker
 * answers the load with the page it has. So the press waits for the new
 * worker when it is still being fetched, asks it in, and reloads only once it
 * holds the page. With no newer worker to ask, the button comes back and the
 * browser is asked for one again. A take-over that never comes (the worker
 * was thrown away) gives the button back too.
 *
 * Compared with the host's own version file, not with the registry: the page
 * and its files are what has to agree. A registry that outruns the console
 * answers the console's calls as it always did, or refuses them by name.
 */

export interface VersionState {
  /** The host serves a build that is not this page's. */
  readonly newer: boolean
  /** Its person pressed: the new build is on its way in. */
  readonly updating: boolean
}

interface WaitingWorker {
  postMessage(message: unknown): void
}

interface InstallingWorker {
  readonly state: string
  addEventListener(type: 'statechange', listener: () => void): void
}

interface WorkerRegistration {
  update(): Promise<unknown>
  readonly waiting: WaitingWorker | null
  readonly installing: InstallingWorker | null
}

/** How long a press waits for a worker that is still being fetched, and for one that was asked in to take over. */
const INSTALL_WAIT_MS = 20_000
const TAKE_OVER_WAIT_MS = 10_000

export interface VersionDeps {
  /** The build this page is; null on a page that was not built (served for development). */
  readonly own: string | null
  fetchVersion(): Promise<{ version?: unknown; build?: unknown } | null>
  registration(): Promise<WorkerRegistration | null>
  /** A worker holds this page: a reload would be answered by it, with the page it has. */
  controlled(): boolean
  onControllerChange(listener: () => void): void
  reload(): void
  wait(ms: number): Promise<void>
}

export interface VersionWatch {
  get(): VersionState
  subscribe(listener: () => void): () => void
  /** Ask the host which build it serves. Safe to call often; never throws. */
  check(): Promise<void>
  /** The person pressed. */
  update(): Promise<void>
}

const BUILD = /^[0-9a-f]{12}$/

export function createVersionWatch(deps: VersionDeps): VersionWatch {
  let state: VersionState = { newer: false, updating: false }
  const listeners = new Set<() => void>()
  const set = (next: VersionState): void => {
    if (next.newer === state.newer && next.updating === state.updating) return
    state = next
    for (const listener of listeners) listener()
  }
  // Only a take-over this page asked for reloads it: another tab's press is that tab's.
  deps.onControllerChange(() => {
    if (state.updating) deps.reload()
  })
  const registration = (): Promise<WorkerRegistration | null> => deps.registration().catch(() => null)
  /** The worker waiting to come in; one still being fetched is waited for, for a while. */
  const waitingOf = async (held: WorkerRegistration | null): Promise<WaitingWorker | null> => {
    if (held === null || held.waiting !== null) return held?.waiting ?? null
    const coming = held.installing
    if (coming === null) return null
    const done = new Promise<void>((resolve) =>
      coming.addEventListener('statechange', () => {
        if (coming.state === 'installed' || coming.state === 'redundant') resolve()
      })
    )
    await Promise.race([done, deps.wait(INSTALL_WAIT_MS)])
    return held.waiting
  }
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    async check() {
      if (deps.own === null) return
      const served = await deps.fetchVersion().catch(() => null)
      const build = served !== null && typeof served.build === 'string' && BUILD.test(served.build) ? served.build : null
      if (build === null || build === deps.own) return
      set({ ...state, newer: true })
      // Fetched now, so it is waiting by the time anyone presses.
      await (await registration())?.update().catch(() => undefined)
    },
    async update() {
      set({ ...state, updating: true })
      // No worker holds the page: the host answers the load.
      if (!deps.controlled()) return deps.reload()
      const held = await registration()
      const waiting = await waitingOf(held)
      if (waiting === null) {
        // Nothing to ask in yet. The button comes back, and the browser is asked for the worker again.
        set({ ...state, updating: false })
        await held?.update().catch(() => undefined)
        return
      }
      waiting.postMessage('take-over')
      // The page loads again when that worker holds it (onControllerChange). If it never does, the button comes back.
      void deps.wait(TAKE_OVER_WAIT_MS).then(() => set({ ...state, updating: false }))
    }
  }
}

/** The watch as a page has it. */
export function browserVersionWatch(): VersionWatch {
  const workers = 'serviceWorker' in navigator ? navigator.serviceWorker : null
  const meta = document.querySelector('meta[name="cookrew-build"]')?.getAttribute('content') ?? null
  return createVersionWatch({
    own: meta !== null && BUILD.test(meta) ? meta : null,
    fetchVersion: async () => {
      const answer = await fetch('/version.json', { cache: 'no-store' })
      return answer.ok ? ((await answer.json()) as { version?: unknown; build?: unknown }) : null
    },
    registration: async () => (await workers?.getRegistration()) ?? null,
    controlled: () => (workers?.controller ?? null) !== null,
    onControllerChange: (listener) => workers?.addEventListener('controllerchange', listener),
    reload: () => window.location.reload(),
    wait: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))
  })
}
