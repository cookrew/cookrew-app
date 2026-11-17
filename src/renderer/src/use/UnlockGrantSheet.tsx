import { useEffect, useState, useSyncExternalStore } from 'react'
import { cookrew } from '../api'
import { clientBase } from '../api-base'
import { authStore } from '../auth-gate'
import { keepGrant, pollGrant, startGrant, type GrantApi } from './unlock-grant-flow'
import { closeUnlockGrantSheet, subscribeUnlockGrantSheet, unlockGrantSheetOpen } from './unlock-grant-store'
import { browserVaultStore, createUnlockVault } from './unlock-vault'

/**
 * SET UP UNLOCK FROM HERE: the words this browser and the Mac both worked out,
 * for someone to compare at the Mac or on a device that can already unlock it.
 * Waits for that answer and keeps what it proves (unlock-grant-flow.ts).
 */

export type GrantPhase =
  | { readonly kind: 'starting' }
  | { readonly kind: 'waiting'; readonly words: readonly string[] }
  | { readonly kind: 'done'; readonly by: string | null }
  | { readonly kind: 'failed'; readonly message: string }

const POLL_MS = 2_000

const hold = (event: React.PointerEvent): void => event.stopPropagation()

export function UnlockGrantSheetView({ phase, onRetry, onClose }: { phase: GrantPhase; onRetry: () => void; onClose: () => void }): React.JSX.Element {
  return (
    <div className="rp-confirm-scrim" role="dialog" aria-modal="true" aria-label="Set up unlock" onPointerDown={hold}>
      <div className="rp-confirm">
        <h3>Set up unlock from here</h3>
        {phase.kind === 'starting' && <p role="status">Asking this Mac…</p>}
        {phase.kind === 'waiting' && (
          <>
            <p>Approve this browser on the Mac, or on a device that can already unlock it. Approve only if it shows these words:</p>
            <p className="rp-unlock-words">{phase.words.join(' ')}</p>
            <p className="rp-note">Nothing secret travels until then, and the words prove nothing stands between this browser and the Mac.</p>
          </>
        )}
        {phase.kind === 'done' && <p role="status">This browser can now unlock this Mac with its password{phase.by ? `, allowed by ${phase.by}` : ''}.</p>}
        {phase.kind === 'failed' && <p className="rp-unlock-error" role="alert">{phase.message}</p>}
        <div className="rp-actions">
          {phase.kind === 'failed' && <button type="button" className="rp-action rp-primary" onClick={onRetry}>Try again</button>}
          <button type="button" className={phase.kind === 'done' ? 'rp-action rp-primary' : 'rp-action'} onClick={onClose}>{phase.kind === 'done' ? 'Done' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  )
}

const grantApi = (): GrantApi | null => {
  const { unlockGrantAsk: ask, unlockGrantReveal: reveal, unlockGrantStatus: status } = cookrew()
  return ask && reveal && status ? { ask, reveal, status } : null
}

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure))

function UnlockGrantSheetBody(): React.JSX.Element {
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<GrantPhase>({ kind: 'starting' })

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const api = grantApi()
    setPhase({ kind: 'starting' })
    if (api === null) {
      setPhase({ kind: 'failed', message: 'This page cannot set up unlock.' })
      return
    }
    // The Mac's key for this machine is pinned where the unlock sheet looks (UnlockSheet.tsx · flowFor).
    const machine = clientBase()
    void (async () => {
      const started = await startGrant(api)
      if (!alive) return
      if (started.kind === 'error') return setPhase({ kind: 'failed', message: started.message })
      const { session } = started
      setPhase({ kind: 'waiting', words: session.words })
      const look = async (): Promise<void> => {
        if (!alive) return
        const polled = await pollGrant(api, session).catch((failure: unknown) => ({ kind: 'error' as const, message: messageOf(failure) }))
        if (!alive) return
        if (polled.kind === 'waiting') {
          timer = setTimeout(() => void look(), POLL_MS)
          return
        }
        if (polled.kind !== 'done') return setPhase({ kind: 'failed', message: polled.message })
        await keepGrant(polled, { saveCode: (code) => authStore().saveConnectCode(code), vault: createUnlockVault(browserVaultStore()), machine })
        if (alive) setPhase({ kind: 'done', by: polled.by })
      }
      timer = setTimeout(() => void look(), POLL_MS)
    })().catch((failure: unknown) => {
      if (alive) setPhase({ kind: 'failed', message: messageOf(failure) })
    })
    return () => {
      alive = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [attempt])

  return <UnlockGrantSheetView phase={phase} onRetry={() => setAttempt((tries) => tries + 1)} onClose={() => closeUnlockGrantSheet(phase.kind === 'done')} />
}

export function UnlockGrantSheet(): React.JSX.Element | null {
  const open = useSyncExternalStore(subscribeUnlockGrantSheet, unlockGrantSheetOpen, unlockGrantSheetOpen)
  return open ? <UnlockGrantSheetBody /> : null
}
