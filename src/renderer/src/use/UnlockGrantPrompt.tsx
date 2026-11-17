import { useEffect, useState } from 'react'
import type { GrantPending } from '../../../shared/unlock-grant'
import { cookrew } from '../api'
import { remoteWhere } from './remote-acts'
import { openApproveApi, type ApproveApi } from './unlock-grant-approve'
import { unlockReach } from './unlock-reach'

/**
 * ANOTHER DEVICE ASKS TO UNLOCK THIS MAC, and this one can already: it may vouch
 * for it, from anywhere, by comparing the words on the two screens. The Mac's own
 * window never shows this; it asks in a system dialog with Touch ID instead.
 */

const hold = (event: React.PointerEvent): void => event.stopPropagation()

export function UnlockGrantPromptView({ ask, busy, error, onAllow, onDeny, onLater }: { ask: GrantPending; busy: boolean; error: string | null; onAllow: () => void; onDeny: () => void; onLater: () => void }): React.JSX.Element {
  return (
    <div className="rp-confirm-scrim" role="dialog" aria-modal="true" aria-label="Allow a device to unlock this Mac" onPointerDown={hold}>
      <div className="rp-confirm">
        <h3>Let {ask.name} unlock this Mac?</h3>
        <p>Allow only if that device shows exactly these words:</p>
        <p className="rp-unlock-words">{ask.words.join(' ')}</p>
        <p className="rp-note">It can then unlock this Mac with its password, from any network.</p>
        {error && <p className="rp-unlock-error" role="alert">{error}</p>}
        <div className="rp-actions">
          <button type="button" className="rp-action" disabled={busy} onClick={onAllow}>Allow</button>
          <button type="button" className="rp-action rp-primary" disabled={busy} onClick={onDeny}>Don’t allow</button>
          <button type="button" className="rp-action" disabled={busy} onClick={onLater}>Later</button>
        </div>
      </div>
    </div>
  )
}

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure))

export function UnlockGrantPrompt(): React.JSX.Element | null {
  const [waiting, setWaiting] = useState(0)
  const [asks, setAsks] = useState<readonly GrantPending[]>([])
  const [later, setLater] = useState<ReadonlySet<string>>(new Set())
  const [api, setApi] = useState<ApproveApi | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (remoteWhere() === 'here') return
    return cookrew().onUnlockGrants?.(setWaiting)
  }, [])

  // A count above nought, on a device that can vouch: read the list, inside.
  useEffect(() => {
    if (waiting === 0 || unlockReach(remoteWhere()) !== 'ready') {
      setAsks([])
      return
    }
    let alive = true
    let opened: ApproveApi | null = null
    void openApproveApi()
      .then(async (way) => {
        opened = way
        if (!alive || way === null) return way?.close()
        const listed = await way.pending()
        if (!alive) return
        setApi(way)
        setAsks(listed.ok ? listed.pending : [])
      })
      .catch(() => undefined)
    return () => {
      alive = false
      opened?.close()
      setApi(null)
    }
  }, [waiting])

  const ask = asks.find((one) => !later.has(one.id) && one.until > Date.now()) ?? null
  if (ask === null || api === null) return null

  const decide = (allow: boolean): void => {
    setBusy(true)
    setError(null)
    void api
      .decide(ask.id, allow)
      .then((answer) => {
        // A refusal stays on screen with its reason; Later puts it away.
        if (!answer.ok) return setError(answer.error)
        setAsks((all) => all.filter((one) => one.id !== ask.id))
      })
      .catch((failure: unknown) => setError(messageOf(failure)))
      .finally(() => setBusy(false))
  }

  const putAway = (): void => {
    setError(null)
    setLater((held) => new Set(held).add(ask.id))
  }
  return <UnlockGrantPromptView ask={ask} busy={busy} error={error} onAllow={() => decide(true)} onDeny={() => decide(false)} onLater={putAway} />
}
