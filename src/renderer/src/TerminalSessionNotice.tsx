import { useEffect, useState } from 'react'
import { cookrew } from './api'
import './door-moved.css'

/**
 * TERMINALS FROM AN EARLIER LOGIN (owner, 2026-11-01: aws_mfa_refresh said "No
 * MFA device found" in a Cookrew terminal and worked in iTerm).
 *
 * The terminals' herdr server outlives Cookrew on purpose, and so can outlive
 * the macOS login it started in; its terminals then cannot resolve a host name
 * or open an app (main/terminal-session.ts). Nothing in a terminal says why —
 * every tool reports its own symptom — so the app does, in the door-moved
 * card's form: it stays until it is answered, because the fault does. LATER
 * hides it for this server; a server started in this login never shows it.
 */

interface Session {
  stale: boolean
  serverPid: number | null
  serverStartedAt: number | null
  loginAt: number | null
}

/** Asked again now and then: a login can end while the window stays open on another Mac's screen. */
const ASK_MS = 5 * 60_000
const LATER_KEY = 'cookrew.old-login.later'

const when = (at: number): string =>
  new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** What the card says. Pure, so the words are tested. */
export function oldLoginSentence(session: Session): string | null {
  if (!session.stale || session.serverStartedAt === null || session.loginAt === null) return null
  return (
    `Your terminals run under a herdr server from an earlier macOS login ` +
    `(started ${when(session.serverStartedAt)}; this login ${when(session.loginAt)}). ` +
    `In them host names do not resolve and apps do not open: aws, curl and npm fail there while a new iTerm window works. ` +
    `Restarting herdr${session.serverPid === null ? '' : ` (pid ${session.serverPid})`} in this login fixes it, and closes every terminal.`
  )
}

const laterFor = (session: Session): string => String(session.serverStartedAt ?? '')

export function TerminalSessionNotice(): React.JSX.Element | null {
  const [session, setSession] = useState<Session | null>(null)
  const [later, setLater] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(LATER_KEY)
    } catch {
      return null
    }
  })

  useEffect(() => {
    let live = true
    const ask = (): void =>
      void cookrew()
        .terminalSession?.()
        .then((next) => live && setSession(next))
        .catch(() => undefined)
    ask()
    const timer = window.setInterval(ask, ASK_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [])

  const sentence = session ? oldLoginSentence(session) : null
  if (!session || !sentence || later === laterFor(session)) return null
  const dismiss = (): void => {
    const key = laterFor(session)
    setLater(key)
    try {
      window.localStorage.setItem(LATER_KEY, key)
    } catch {
      // Private mode: it comes back next time, and that is all.
    }
  }
  return (
    <div className="door-moved old-login" role="alert">
      <div className="door-moved-card">
        <span className="door-moved-g" aria-hidden="true">
          ⏻
        </span>
        <div className="door-moved-body">
          <span className="door-moved-s">{sentence}</span>
          <div className="door-moved-row">
            <button type="button" className="door-moved-b" onClick={dismiss}>
              LATER
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
