import { readFileSync } from 'node:fs'
import { isNewer, parseUpdateRelease, readRelease, RELEASES_API, type UpdateRelease, type UpdateStatus } from '../shared/update-check'
import { writeFileAtomic } from './atomic-file'

/**
 * ASKING GITHUB WHETHER THERE IS A NEWER COOKREW.
 *
 * One small unauthenticated read, soon after launch and then on a timer, in a
 * packaged build only: a source build moves by git, so its version says
 * nothing. A failure is never news: the row stays as it was and the next try
 * comes sooner. The last check is remembered so a day of restarts stays a few
 * reads, and Off is remembered so it holds across them.
 */

/** Long enough that the check is never part of the launch. */
export const BOOT_DELAY_MS = 30_000
export const CHECK_EVERY_MS = 6 * 60 * 60_000
export const RETRY_MS = 60 * 60_000
const ANSWER_DEADLINE_MS = 10_000

interface Saved {
  readonly on: boolean
  readonly checkedAt: number
  readonly latest: UpdateRelease | null
}

const FRESH: Saved = { on: true, checkedAt: 0, latest: null }

function readSaved(file: string): Saved {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { on?: unknown; checkedAt?: unknown; latest?: unknown } | null
    return {
      on: raw?.on !== false,
      checkedAt: typeof raw?.checkedAt === 'number' && Number.isFinite(raw.checkedAt) ? raw.checkedAt : 0,
      latest: parseUpdateRelease(raw?.latest)
    }
  } catch {
    return FRESH
  }
}

export interface UpdateCheckDeps {
  readonly version: string
  readonly file: string
  fetch(url: string, init: RequestInit): Promise<Response>
  /** The page should hear this status. */
  publish(status: UpdateStatus): void
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
}

export interface UpdateCheck {
  start(): void
  stop(): void
  status(): UpdateStatus
  setOn(on: boolean): UpdateStatus
}

const timer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms)
  handle.unref()
  return () => clearTimeout(handle)
}

async function askGitHub(fetcher: UpdateCheckDeps['fetch']): Promise<UpdateRelease> {
  const response = await fetcher(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cookrew-update-check' },
    signal: AbortSignal.timeout(ANSWER_DEADLINE_MS)
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  const release = readRelease(await response.json())
  if (release === null) throw new Error('GitHub answered with no readable release')
  return release
}

export function createUpdateCheck(deps: UpdateCheckDeps): UpdateCheck {
  const now = deps.now ?? Date.now
  const schedule = deps.schedule ?? timer
  let saved = readSaved(deps.file)
  let cancel: (() => void) | null = null
  /** Which ask is current: an answer begun before Off is no answer after it. */
  let asking = 0

  const remember = (next: Saved): void => {
    saved = next
    try {
      writeFileAtomic(deps.file, JSON.stringify(next))
    } catch (error) {
      // Worst case the next launch asks a little early, or Off needs pressing again.
      console.error('[cookrew] could not save the update check:', error)
    }
  }

  const status = (): UpdateStatus => ({
    on: saved.on,
    available: saved.on && saved.latest !== null && isNewer(saved.latest.version, deps.version) ? saved.latest : null
  })

  const next = (ms: number): void => {
    cancel?.()
    cancel = schedule(() => {
      cancel = null
      void ask()
    }, ms)
  }

  async function ask(): Promise<void> {
    asking += 1
    const mine = asking
    const answer = await askGitHub(deps.fetch).catch(() => null)
    if (mine !== asking || !saved.on) return
    if (answer === null) return next(RETRY_MS)
    remember({ ...saved, checkedAt: now(), latest: answer })
    deps.publish(status())
    next(CHECK_EVERY_MS)
  }

  const stop = (): void => {
    cancel?.()
    cancel = null
  }

  return {
    start() {
      if (saved.on) next(Math.max(BOOT_DELAY_MS, saved.checkedAt + CHECK_EVERY_MS - now()))
    },
    stop,
    status,
    setOn(on) {
      if (on === saved.on) return status()
      asking += 1
      remember({ ...saved, on })
      if (on) next(0)
      else stop()
      return status()
    }
  }
}
