import { useEffect, useState } from 'react'
import { cookrew, isRemoteMode } from './api'
import { subscribeDataPlane } from './data-plane'
import { currentPathBadge, subscribePathLink } from './path-link'
import type { PathBadgeView } from '../../shared/path-badge'

/**
 * THE PATH BADGE — what the companion knows about the wire it is on.
 *
 * The word is the fact, not a promise. LAN means this page was served over the
 * LAN, right now; OFFLINE means the push channel is down whatever the address
 * bar says. Nothing here probes: the companion is ALREADY on the path it is
 * describing, so a probe would be measuring a hypothesis.
 *
 * It used to be a button of its own at the top-left of the companion bar. That
 * corner is the route now (device / workspace / agent), so the badge is said
 * twice in smaller ways: its DOT rides the device step — the desktop is the
 * thing the path reaches, and an OFFLINE grey there is still seen without a
 * tap — and its word heads the Connection row of the More menu, which
 * refreshes and opens the sheet as the badge's tap did.
 */
export function usePathBadge(): PathBadgeView {
  const [view, setView] = useState<PathBadgeView>(() => currentPathBadge())
  useEffect(() => {
    // The view reads two stores (path-link.ts · currentPathBadge): the link,
    // and the data plane that names the path.
    const refresh = (): void => setView(currentPathBadge())
    const offs = [subscribePathLink(refresh), subscribeDataPlane(refresh)]
    return () => offs.forEach((off) => off())
  }, [])
  return view
}

/** One dot and one word, wearing the state as a class so the dot can be coloured. */
export function PathBadge({ view }: { view: PathBadgeView }): React.JSX.Element {
  return (
    <span className={`cr-path cr-path-${view.state.toLowerCase()}`} title={view.sentence}>
      <span className="cr-path-dot" aria-hidden="true" />
      <span className="cr-path-word">{view.word}</span>
    </span>
  )
}

/** The dot alone, for the route's device step. */
export function PathDot({ view }: { view: PathBadgeView }): React.JSX.Element {
  return (
    <span className={`cr-route-path cr-path-${view.state.toLowerCase()}`} role="img" aria-label={`Connection: ${view.word}`} title={view.sentence}>
      <span className="cr-path-dot" />
    </span>
  )
}

/**
 * The sentence, the latency, and the way to another desktop — and nothing to
 * do. The path finds itself (LAN > tailnet > relay, path/rtc-adopt.ts), so a
 * retry button, a certificate to install or a table of what timed out would
 * each be a chore for something that is not the reader's job. The evidence
 * still reaches the Mac in the path reports, where it is read.
 */
export function PathSheet({
  view,
  onClose
}: {
  view: PathBadgeView
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label="Connection">
      <div
        className="gs-sheet gs-small cr-sheet cr-path-sheet"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>{view.desktopName ?? 'This desktop'}</h2>
          <button className="gs-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <p className="gs-sub">{view.sentence}</p>
        <p className="cr-path-latency">
          {view.latencyMs === null ? 'Latency not measured yet.' : `${view.latencyMs} ms round trip`}
        </p>
        <footer className="gs-sheet-foot">
          {/* Offered on the console only: its first level is the account's machines. */}
          {view.switchDesktopUrl && (
            <a className="cr-path-switch" href={view.switchDesktopUrl}>
              Your machines
            </a>
          )}
        </footer>
      </div>
    </div>
  )
}

/**
 * The phone's account: the OWNER's, since it is the desktop's account and the
 * phone is one of its devices — so the initials come from the desktop when it
 * can answer, and the circle is dashed when there is no account at all. It is
 * read-only here on purpose: claiming a name, changing a password and revoking
 * a device all happen where the key lives.
 */
export function useCompanionInitials(): string | null {
  const [initials, setInitials] = useState<string | null>(null)
  useEffect(() => {
    if (!isRemoteMode()) return
    let live = true
    const load = cookrew().accountStatus
    if (!load) return
    void load()
      .then((status) => {
        if (!live) return
        const source = status.displayName || status.username || ''
        setInitials(source ? initialsOf(source) : null)
      })
      .catch(() => undefined)
    return () => void (live = false)
  }, [])
  return initials
}

/** The avatar's slot on the phone, at the end of the function bar. */
export function CompanionAvatar(): React.JSX.Element {
  const initials = useCompanionInitials()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={`cr-acct-avatar ${initials ? 'cr-acct-claimed' : 'cr-acct-none'}`}
        aria-label={initials ? `Account ${initials}` : 'No account on this desktop'}
        onClick={() => setOpen(true)}
      >
        <span className="cr-acct-initials">{initials ?? '?'}</span>
      </button>
      {open && (
        <div
          className="gs-scrim cr-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Account"
          onClick={() => setOpen(false)}
        >
          <div className="gs-sheet gs-small cr-sheet cr-path-sheet">
            <header className="gs-sheet-head">
              <h2>{initials ? 'Account' : 'No account'}</h2>
              <button className="gs-x" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </header>
            <p className="gs-sub">Manage your account on the Mac.</p>
          </div>
        </div>
      )}
    </>
  )
}

/** Two letters, the same rule the desktop avatar uses. */
const initialsOf = (source: string): string => {
  const words = source.trim().split(/[\s_-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[1][0]}`.toUpperCase()
}
