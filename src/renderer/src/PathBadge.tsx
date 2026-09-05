import { useEffect, useState } from 'react'
import { cookrew, isRemoteMode } from './api'
import { currentPathBadge, subscribePathLink } from './path-link'
import type { PathBadgeView } from '../../shared/path-badge'

/**
 * THE PATH BADGE — top-left of the companion bar, where the hand mark was.
 *
 * It replaces the mark rather than sitting beside it because the phone's brand
 * group has room for exactly one 24 px thing and because the two do the same
 * job: the mark was the always-visible control that said "ask again", and the
 * badge is the always-visible control that says "this is how I am asking, and
 * it still works". Tapping it therefore still refreshes — that gesture is
 * three years old on this bar and nothing here is worth retraining it.
 *
 * The word is the fact, not a promise. LAN means this page was served over the
 * LAN, right now; OFFLINE means the push channel is down whatever the address
 * bar says. Nothing here probes: the companion is ALREADY on the path it is
 * describing, so a probe would be measuring a hypothesis.
 */
export function PathBadge({ onRefresh }: { onRefresh: () => void }): React.JSX.Element {
  const [view, setView] = useState<PathBadgeView>(() => currentPathBadge())
  const [open, setOpen] = useState(false)

  useEffect(() => subscribePathLink(() => setView(currentPathBadge())), [])

  return (
    <>
      <button
        type="button"
        className={`cr-path cr-path-${view.state.toLowerCase()}`}
        aria-label={`Connection: ${view.word}. Tap to refresh and see details.`}
        title={view.sentence}
        onClick={() => {
          // Both, in this order: the refresh is what the hand did and the user
          // expects it instantly; the sheet explains what they just refreshed.
          onRefresh()
          setOpen(true)
        }}
      >
        <span className="cr-path-dot" aria-hidden="true" />
        <span className="cr-path-word">{view.word}</span>
      </button>
      {open && <PathSheet view={view} onClose={() => setOpen(false)} />}
    </>
  )
}

/** The sentence, the latency, and the way to another desktop. */
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
          {/* Offered only once the desktop has said where its account lives.
              A hard-coded cookrew.dev sends a self-hosting owner somewhere
              that has never heard of them. */}
          {view.switchDesktopUrl && (
            <a className="cr-path-switch" href={view.switchDesktopUrl} rel="noreferrer">
              Switch desktop
            </a>
          )}
        </footer>
      </div>
    </div>
  )
}

/**
 * The avatar's slot on the phone, where the violet handset icon used to sit.
 *
 * The phone sees the OWNER's account — it is the desktop's account, and the
 * phone is one of its devices — so the initials come from the desktop when it
 * can answer, and the circle is dashed when there is no account at all. It is
 * read-only here on purpose: claiming a name, changing a password and revoking
 * a device all happen where the key lives.
 */
export function CompanionAvatar(): React.JSX.Element {
  const [initials, setInitials] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

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
