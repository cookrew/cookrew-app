// THE PHONE'S WAY TO A LOCKED MAC, from any network. On a page the Mac served itself
// it asks directly; anywhere else it goes inside the sealed session, which needs the
// connect code from the Mac's own screen, once (shared/remote-unlock.ts says what that
// does and does not stop). The first time it shows the Mac's key in six words to
// compare with the ⋯ menu there; after that the key is pinned, and a changed one
// stops with nothing sent.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { hostOutsideTheMac, UNLOCK_PASSWORD_MAX } from '../../../shared/remote-unlock'
import { cookrew } from '../api'
import { clientBase } from '../api-base'
import { authHeaders, authStore, connectCodeFromInput } from '../auth-gate'
import { seated } from '../device-seat'
import { openSeal, SealRefusedError, type SealClient } from '../path/seal-client'
import { closeUnlockSheet, subscribeUnlockSheet, unlockSheetOpen } from './unlock-sheet-store'
import { prepareUnlock, runUnlock, type UnlockFlowDeps } from './unlock-flow'
import { wordsOfKey } from './unlock-seal'
import { sealedUnlockApi } from './unlock-sealed'
import { browserVaultStore, createUnlockVault, type KeyTrust } from './unlock-vault'

export interface UnlockSheetViewProps {
  /** This device has no connect code, or one the Mac no longer knows. */
  needsCode: boolean
  /** It had one, and it is out of date. */
  stale: boolean
  /** Only on a page the Mac served itself: a saved password needs no typing to be read. */
  canRemember: boolean
  onCode: (pasted: string) => void
  trust: KeyTrust | null
  words: readonly string[] | null
  saved: boolean
  busy: boolean
  error: string | null
  password: string
  remember: boolean
  onPassword: (value: string) => void
  onRemember: (value: boolean) => void
  onUnlock: () => void
  onForget: () => void
  onTrustNew: () => void
  onClose: () => void
}

const hold = (event: React.PointerEvent): void => event.stopPropagation()

function ChangedKey({ words, onTrustNew, onClose }: Pick<UnlockSheetViewProps, 'words' | 'onTrustNew' | 'onClose'>): React.JSX.Element {
  return (
    <>
      <h3>This Mac’s key changed</h3>
      <p>Nothing was sent. Only continue if these words match the ⋯ menu on the Mac itself:</p>
      {words && <p className="rp-unlock-words">{words.join(' ')}</p>}
      <div className="rp-actions">
        <button type="button" className="rp-action" onClick={onTrustNew}>They match</button>
        <button type="button" className="rp-action rp-primary" onClick={onClose}>Cancel</button>
      </div>
    </>
  )
}

function PasswordForm(props: UnlockSheetViewProps): React.JSX.Element {
  const { trust, words, saved, busy, password, remember, onPassword, onRemember, onUnlock, onForget, onClose } = props
  return (
    <>
      <h3>Unlock this Mac</h3>
      {trust === 'new' && words && (
        <>
          <p>First time from this device. When you are next at the Mac, check these words match its ⋯ menu:</p>
          <p className="rp-unlock-words">{words.join(' ')}</p>
        </>
      )}
      {saved ? (
        <p>This device remembers the password.</p>
      ) : (
        <>
          <input className="rp-unlock-input" type="password" aria-label="Mac password" autoComplete="off" maxLength={UNLOCK_PASSWORD_MAX} value={password} disabled={busy} onChange={(event) => onPassword(event.target.value)} />
          {props.canRemember && (
            <label className="rp-unlock-remember">
              <input type="checkbox" checked={remember} disabled={busy} onChange={(event) => onRemember(event.target.checked)} />
              <span>Remember on this device. Anyone who can open Cookrew on it can then unlock this Mac.</span>
            </label>
          )}
        </>
      )}
      <div className="rp-actions">
        <button type="button" className="rp-action rp-primary" disabled={busy || (!saved && password.length === 0)} onClick={onUnlock}>{busy ? 'Unlocking…' : 'Unlock'}</button>
        {saved && <button type="button" className="rp-action" disabled={busy} onClick={onForget}>Forget password</button>}
        <button type="button" className="rp-action" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </>
  )
}

function NeedsCode({ stale, onCode, onClose }: Pick<UnlockSheetViewProps, 'stale' | 'onCode' | 'onClose'>): React.JSX.Element {
  const [pasted, setPasted] = useState('')
  return (
    <>
      <h3>Unlock this Mac</h3>
      {stale && <p>The pairing code on this device is out of date.</p>}
      <p>To unlock from any network, this device needs the pairing code, once. At the Mac, open Pair a phone, then scan it in this browser or paste the link here.</p>
      <input className="rp-unlock-input" aria-label="Pairing link" autoComplete="off" spellCheck={false} value={pasted} onChange={(event) => setPasted(event.target.value)} />
      <div className="rp-actions">
        <button type="button" className="rp-action rp-primary" disabled={pasted.trim() === ''} onClick={() => onCode(pasted)}>Use this link</button>
        <button type="button" className="rp-action" onClick={onClose}>Cancel</button>
      </div>
    </>
  )
}

function SheetBody(props: UnlockSheetViewProps): React.JSX.Element {
  if (props.needsCode) return <NeedsCode stale={props.stale} onCode={props.onCode} onClose={props.onClose} />
  return props.trust === 'changed' ? <ChangedKey words={props.words} onTrustNew={props.onTrustNew} onClose={props.onClose} /> : <PasswordForm {...props} />
}

export function UnlockSheetView(props: UnlockSheetViewProps): React.JSX.Element {
  return (
    <div className="rp-confirm-scrim" role="dialog" aria-modal="true" aria-label="Unlock this Mac" onPointerDown={hold}>
      <div className="rp-confirm">
        <SheetBody {...props} />
        {props.error && <p className="rp-unlock-error" role="alert">{props.error}</p>}
      </div>
    </div>
  )
}

/** A page the Mac served itself, on an address cookrew.dev does not answer for. */
const onTheMacsOwnPage = (): boolean => clientBase() === '' && !hostOutsideTheMac(window.location.host)

const flowFor = (api: UnlockFlowDeps['api']): UnlockFlowDeps => ({ api, vault: createUnlockVault(browserVaultStore()), machine: clientBase() })

const directFlow = (): UnlockFlowDeps | null => {
  const { remoteUnlockBegin: begin, remoteUnlock: send } = cookrew()
  return begin && send ? flowFor({ begin, send }) : null
}

type Way =
  | { readonly kind: 'opening' }
  | { readonly kind: 'ready'; readonly deps: UnlockFlowDeps }
  | { readonly kind: 'needs-code'; readonly stale: boolean }
  | { readonly kind: 'failed'; readonly message: string }

/** How this device reaches the door. `attempt` asks again, after a new code. */
function useUnlockWay(attempt: number): Way {
  const [way, setWay] = useState<Way>({ kind: 'opening' })
  useEffect(() => {
    if (onTheMacsOwnPage()) {
      const deps = directFlow()
      setWay(deps ? { kind: 'ready', deps } : { kind: 'failed', message: 'This device cannot unlock a Mac.' })
      return
    }
    const code = authStore().connectCode()
    if (!code) return setWay({ kind: 'needs-code', stale: false })
    let alive = true
    let client: SealClient | null = null
    setWay({ kind: 'opening' })
    // The relay's prefix and nothing else: this must not follow a direct plane
    // or a slug. Read once: the session is with the machine it was opened to,
    // and stays there if another is entered before the sheet is gone.
    const base = clientBase()
    openSeal({ url: (path) => `${base}${path}`, code })
      .then((opened) => {
        client = opened
        if (!alive) return opened.close()
        setWay({ kind: 'ready', deps: flowFor(sealedUnlockApi(opened, authHeaders, seated)) })
      })
      .catch((failure: unknown) => {
        if (!alive) return
        const stale = failure instanceof SealRefusedError && failure.why === 'code'
        setWay(stale ? { kind: 'needs-code', stale } : { kind: 'failed', message: messageOf(failure) })
      })
    return () => {
      alive = false
      client?.close()
    }
  }, [attempt])
  return way
}

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure))

function UnlockSheetBody(): React.JSX.Element {
  const [attempt, setAttempt] = useState(0)
  const way = useUnlockWay(attempt)
  const deps = way.kind === 'ready' ? way.deps : null
  const [shown, setShown] = useState<{ key: string; trust: KeyTrust; saved: boolean; words: readonly string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)

  const prepare = useCallback(async (): Promise<void> => {
    if (!deps) return
    const prepared = await prepareUnlock(deps)
    if (prepared.kind === 'done') return closeUnlockSheet(true)
    if (prepared.kind === 'error') return setError(prepared.message)
    setShown({ key: prepared.key, trust: prepared.trust, saved: prepared.saved, words: await wordsOfKey(prepared.key) })
  }, [deps])

  useEffect(() => {
    prepare().catch((failure: unknown) => setError(messageOf(failure)))
  }, [prepare])

  const useCode = (pasted: string): void => {
    const code = connectCodeFromInput(pasted)
    if (code === null) return setError('That link has no pairing code in it.')
    authStore().saveConnectCode(code)
    setError(null)
    setAttempt((tries) => tries + 1)
  }

  const unlock = async (): Promise<void> => {
    // Nothing to send yet: the way there failed, and this press is the retry.
    if (!deps || !shown) {
      setError(null)
      return setAttempt((tries) => tries + 1)
    }
    setBusy(true)
    setError(null)
    try {
      const result = await runUnlock(deps, { shownKey: shown.key, password: shown.saved ? null : password, remember })
      if (result.kind === 'done') return closeUnlockSheet(true)
      // The words of the key now on offer: the reader must judge that one, not the one they saw.
      if (result.kind === 'changed') return setShown({ key: result.key, trust: 'changed', saved: false, words: await wordsOfKey(result.key) })
      setError(result.message)
      await prepare()
    } catch (failure) {
      setError(messageOf(failure))
      // The session may be what failed: the next try gets a new one.
      setShown(null)
      setAttempt((tries) => tries + 1)
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  return (
    <UnlockSheetView
      needsCode={way.kind === 'needs-code'}
      stale={way.kind === 'needs-code' && way.stale}
      canRemember={onTheMacsOwnPage()}
      onCode={useCode}
      trust={shown?.trust ?? null}
      words={shown?.words ?? null}
      saved={shown?.saved ?? false}
      busy={busy || (way.kind !== 'needs-code' && shown === null && error === null && way.kind !== 'failed')}
      error={error ?? (way.kind === 'failed' ? way.message : null)}
      password={password}
      remember={remember && onTheMacsOwnPage()}
      onPassword={setPassword}
      onRemember={setRemember}
      onUnlock={() => void unlock()}
      onForget={() => {
        if (deps) void deps.vault.forgetPassword(deps.machine).then(prepare)
      }}
      onTrustNew={() => {
        // Exactly the key the reader judged, with no second fetch that could offer another.
        if (deps && shown) void deps.vault.repin(deps.machine, shown.key).then(() => setShown({ ...shown, trust: 'same', saved: false }))
      }}
      onClose={() => closeUnlockSheet(false)}
    />
  )
}

export function UnlockSheet(): React.JSX.Element | null {
  const open = useSyncExternalStore(subscribeUnlockSheet, unlockSheetOpen, unlockSheetOpen)
  return open ? <UnlockSheetBody /> : null
}
