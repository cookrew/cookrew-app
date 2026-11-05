// THE PHONE'S WAY TO A LOCKED MAC. The first time it shows the Mac's key in six
// words to compare with the ⋯ menu there; after that the key is pinned, and a
// changed one stops here with nothing sent.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { UNLOCK_PASSWORD_MAX } from '../../../shared/remote-unlock'
import { cookrew } from '../api'
import { clientBase } from '../api-base'
import { closeUnlockSheet, subscribeUnlockSheet, unlockSheetOpen } from './unlock-sheet-store'
import { prepareUnlock, runUnlock, type UnlockFlowDeps } from './unlock-flow'
import { wordsOfKey } from './unlock-seal'
import { browserVaultStore, createUnlockVault, type KeyTrust } from './unlock-vault'

export interface UnlockSheetViewProps {
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
          <label className="rp-unlock-remember">
            <input type="checkbox" checked={remember} disabled={busy} onChange={(event) => onRemember(event.target.checked)} />
            <span>Remember on this device. Anyone who can open Cookrew on it can then unlock this Mac.</span>
          </label>
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

export function UnlockSheetView(props: UnlockSheetViewProps): React.JSX.Element {
  return (
    <div className="rp-confirm-scrim" role="dialog" aria-modal="true" aria-label="Unlock this Mac" onPointerDown={hold}>
      <div className="rp-confirm">
        {props.trust === 'changed' ? <ChangedKey words={props.words} onTrustNew={props.onTrustNew} onClose={props.onClose} /> : <PasswordForm {...props} />}
        {props.error && <p className="rp-unlock-error" role="alert">{props.error}</p>}
      </div>
    </div>
  )
}

const flowDeps = (): UnlockFlowDeps | null => {
  const { remoteUnlockBegin: begin, remoteUnlock: send } = cookrew()
  if (!begin || !send) return null
  return { api: { begin, send }, vault: createUnlockVault(browserVaultStore()), machine: clientBase() }
}

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure))

function UnlockSheetBody(): React.JSX.Element {
  const deps = useMemo(flowDeps, [])
  const [shown, setShown] = useState<{ key: string; trust: KeyTrust; saved: boolean; words: readonly string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)

  const prepare = useCallback(async (): Promise<void> => {
    if (!deps) return setError('This device cannot unlock a Mac.')
    const prepared = await prepareUnlock(deps)
    if (prepared.kind === 'done') return closeUnlockSheet(true)
    if (prepared.kind === 'error') return setError(prepared.message)
    setShown({ key: prepared.key, trust: prepared.trust, saved: prepared.saved, words: await wordsOfKey(prepared.key) })
  }, [deps])

  useEffect(() => {
    prepare().catch((failure: unknown) => setError(messageOf(failure)))
  }, [prepare])

  const unlock = async (): Promise<void> => {
    if (!deps || !shown) return
    setBusy(true)
    setError(null)
    try {
      const result = await runUnlock(deps, { shownKey: shown.key, password: shown.saved ? null : password, remember })
      if (result.kind === 'done') return closeUnlockSheet(true)
      if (result.kind === 'changed') return setShown({ ...shown, trust: 'changed' })
      setError(result.message)
      await prepare()
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  return (
    <UnlockSheetView
      trust={shown?.trust ?? null}
      words={shown?.words ?? null}
      saved={shown?.saved ?? false}
      busy={busy || (shown === null && error === null)}
      error={error}
      password={password}
      remember={remember}
      onPassword={setPassword}
      onRemember={setRemember}
      onUnlock={() => void unlock()}
      onForget={() => {
        if (deps) void deps.vault.forgetPassword(deps.machine).then(prepare)
      }}
      onTrustNew={() => {
        if (deps) void deps.vault.forgetMac(deps.machine).then(prepare)
      }}
      onClose={() => closeUnlockSheet(false)}
    />
  )
}

export function UnlockSheet(): React.JSX.Element | null {
  const open = useSyncExternalStore(subscribeUnlockSheet, unlockSheetOpen, unlockSheetOpen)
  return open ? <UnlockSheetBody /> : null
}
