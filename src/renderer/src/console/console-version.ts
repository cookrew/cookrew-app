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

interface WorkerRegistration {
  update(): Promise<unknown>
  readonly waiting: WaitingWorker | null
}

export interface VersionDeps {
  /** The build this page is; null on a page that was not built (served for development). */
  readonly own: string | null
  fetchVersion(): Promise<{ version?: unknown; build?: unknown } | null>
  registration(): Promise<WorkerRegistration | null>
  onControllerChange(listener: () => void): void
  reload(): void
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
      const waiting = (await registration())?.waiting ?? null
      // With a worker waiting, the page loads again when it has taken over. With none, the host answers the load.
      if (waiting !== null) waiting.postMessage('take-over')
      else deps.reload()
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
    onControllerChange: (listener) => workers?.addEventListener('controllerchange', listener),
    reload: () => window.location.reload()
  })
}
