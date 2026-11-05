import { execFile } from 'node:child_process'
import { chmodSync, readFileSync } from 'node:fs'
import type { RemoteBuild } from '../shared/remote-access'
import { writeFileAtomic } from './atomic-file'
import type { RemoteSession, RemoteSettings, SettingsPane } from './remote-desk'

/**
 * WHAT THE DESK READS THE MACHINE WITH (remote-desk.ts decides; this only asks).
 *
 * One read of the session is a process, so a read is shared while it is in
 * flight and for a moment after. A lock event throws the answer away, so the
 * card hears of a lock in the time an event takes, not the time a cache does.
 * A failed read keeps the last answer: a Mac too busy to start a helper has
 * not locked. Nothing known claims nothing: never a lock, and never a grant.
 */

export const SESSION_FRESH_MS = 3000

const UNKNOWN: RemoteSession = { locked: false, displayAsleep: false, grant: null }

export interface SessionReader {
  read(): Promise<RemoteSession>
  invalidate(): void
}

export function createSessionReader(deps: { read: () => Promise<RemoteSession>; now?: () => number }): SessionReader {
  const now = deps.now ?? Date.now
  let held: { at: number; session: RemoteSession } | null = null
  let last: RemoteSession = UNKNOWN
  let inFlight: Promise<RemoteSession> | null = null
  /** Which read is current: an answer begun before an event is no answer after it. */
  let generation = 0
  return {
    read() {
      if (held && now() - held.at < SESSION_FRESH_MS) return Promise.resolve(held.session)
      if (inFlight) return inFlight
      const mine = generation
      const reading = deps
        .read()
        .catch(() => last)
        .then((session) => {
          if (mine !== generation) return session
          last = session
          held = { at: now(), session }
          return session
        })
        .finally(() => {
          if (inFlight === reading) inFlight = null
        })
      inFlight = reading
      return reading
    },
    invalidate() {
      held = null
      inFlight = null
      generation += 1
    }
  }
}

export type CommandRun = (file: string, args: readonly string[]) => Promise<string>

export const commandRun: CommandRun = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 3000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
  })

const answered = (reading: Promise<string>): Promise<string> => reading.catch(() => '')

/** logind for the lock, X for the display. Neither is always there, and neither being there says nothing. */
export async function linuxSession(env: { XDG_SESSION_ID?: string }, run: CommandRun): Promise<RemoteSession> {
  const id = env.XDG_SESSION_ID
  const [lock, display] = await Promise.all([
    id ? answered(run('loginctl', ['show-session', id, '-p', 'LockedHint', '--value'])) : Promise.resolve(''),
    answered(run('xset', ['q']))
  ])
  return { locked: lock.trim() === 'yes', displayAsleep: /Monitor is (Off|Suspend|Standby)/.test(display), grant: null }
}

export function remoteBuild(input: { execPath: string; packaged: boolean; persists: boolean; servedLive: boolean }): RemoteBuild {
  const bundle = /([^/]+)\.app\/Contents\/MacOS\//.exec(input.execPath)?.[1]
  return {
    settingsName: bundle ?? (input.packaged ? 'Cookrew' : 'Electron'),
    sourceBuild: !input.packaged,
    // A source build is the child of a dev server: relaunched alone it has no renderer to load.
    restart: input.packaged ? 'self' : 'by-hand',
    agents: !input.persists ? 'stop' : input.servedLive ? 'keep-not-served' : 'keep'
  }
}

const PANES: readonly SettingsPane[] = ['screen', 'accessibility']

/**
 * WHAT OUTLIVES A RESTART: Stop's hold, and who is waiting to hear. Never the
 * machine switch, which this does not read even if a file says so: an agent
 * running as this user could write it, and only the Mac may turn that on.
 */
export function remoteSettingsFile(file: string): { read(): RemoteSettings; write(next: RemoteSettings): void } {
  return {
    read() {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { waiting?: unknown; holdUntil?: unknown } | null
        const hold = raw?.holdUntil
        return { waiting: PANES.find((pane) => pane === raw?.waiting) ?? null, holdUntil: typeof hold === 'number' && Number.isFinite(hold) ? hold : 0 }
      } catch {
        return { waiting: null, holdUntil: 0 }
      }
    },
    write(next) {
      writeFileAtomic(file, JSON.stringify(next))
      chmodSync(file, 0o600)
    }
  }
}
