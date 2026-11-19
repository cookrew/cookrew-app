// THE PHONE'S WAY TO A LOCKED MAC, from any network. On a page the Mac served itself
// it asks directly; anywhere else it goes inside the sealed session, which needs the
// connect code from the Mac's own screen, once (shared/remote-unlock.ts says what that
// does and does not stop). The first time it shows the Mac's key in six words to
// compare with the ⋯ menu there; after that the key is pinned, and a changed one
// stops with nothing sent.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { UNLOCK_PASSWORD_MAX } from '../../../shared/remote-unlock'
import { cookrew } from '../api'
import { clientBase } from '../api-base'
import { sealFetchFor } from './seal-fetch'
import { codeKeyForBase, takeNextCode } from '../pairing-scope'
import { authHeaders, authStore, connectCodeFromInput } from '../auth-gate'
import { seated } from '../device-seat'
import { openSeal, SealRefusedError, type SealClient } from '../path/seal-client'
import { sealPinFor } from '../path/seal-pin'
import { vouchedNextCode } from '../path/seal-next-code'
import { closeUnlockSheet, subscribeUnlockSheet, unlockSheetOpen } from './unlock-sheet-store'
import { openUnlockGrantSheet } from './unlock-grant-store'
import { forgetRemembered, prepareUnlock, runUnlock, type UnlockFlowDeps } from './unlock-flow'
import { connectCodeId } from '../../../shared/canvas-seal'
import { decodeBase64Url } from '../../../shared/key-fingerprint'
import { wordsOfKey } from './unlock-seal'
import { sealedUnlockApi } from './unlock-sealed'
import { browserVaultStore, createUnlockVault, type KeyTrust } from './unlock-vault'
import { onTheMacsOwnPage } from './unlock-reach'

export interface UnlockSheetViewProps {
  /** This device has no connect code, or one the Mac no longer knows. */
  needsCode: boolean
  /** It had one, and it is out of date. */
  stale: boolean
  /** Out of date because the machine changed its code, and proved so (seal-client.ts · 'replaced'). */
  changed?: boolean
  /** Only on a page the Mac served itself: a saved password needs no typing to be read. */
  canRemember: boolean
  onCode: (pasted: string) => void
  /** Set up from here, with no QR (UnlockGrantSheet.tsx). Absent where this page cannot. */
  onSetUp?: () => void
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

function NeedsCode({ stale, changed, onCode, onSetUp, onClose }: Pick<UnlockSheetViewProps, 'stale' | 'changed' | 'onCode' | 'onSetUp' | 'onClose'>): React.JSX.Element {
  const [pasted, setPasted] = useState('')
  return (
    <>
      <h3>Unlock this Mac</h3>
      {stale && <p>{changed ? 'The pairing code of this Mac was changed.' : 'The pairing code on this device is out of date.'}</p>}
      <p>This browser needs this Mac’s pairing code before it can unlock the Mac remotely.</p>
      {onSetUp && (
        <>
          <p>Set it up from here: a device that can already unlock this Mac approves it, or someone at the Mac does. Both compare a few words with this screen.</p>
          <div className="rp-actions">
            <button type="button" className="rp-action rp-primary" onClick={onSetUp}>Set up from here</button>
          </div>
        </>
      )}
      <p>{onSetUp ? 'Or, at the unlocked Mac:' : 'At the unlocked Mac:'}</p>
      <ol className="rp-unlock-steps">
        <li>Open Cookrew and select your avatar → Devices → Pair a phone.</li>
        <li>Scan the QR code with this device, open the link in this browser, and sign in if asked. Then return to this Mac in Cookrew and try Unlock again.</li>
      </ol>
      <label className="rp-unlock-label" htmlFor="unlock-pairing-link">Or paste the full link from the QR code</label>
      <input id="unlock-pairing-link" className="rp-unlock-input" aria-label="Pairing link" autoComplete="off" spellCheck={false} value={pasted} onChange={(event) => setPasted(event.target.value)} />
      <div className="rp-actions">
        <button type="button" className={onSetUp ? 'rp-action' : 'rp-action rp-primary'} disabled={pasted.trim() === ''} onClick={() => onCode(pasted)}>Use this link</button>
        <button type="button" className="rp-action" onClick={onClose}>Cancel</button>
      </div>
    </>
  )
}

function SheetBody(props: UnlockSheetViewProps): React.JSX.Element {
  if (props.needsCode) return <NeedsCode stale={props.stale} changed={props.changed} onCode={props.onCode} onSetUp={props.onSetUp} onClose={props.onClose} />
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

const flowFor = (api: UnlockFlowDeps['api'], extra: Partial<Pick<UnlockFlowDeps, 'codeId' | 'plainRemember'>> = {}): UnlockFlowDeps => ({
  api,
  vault: createUnlockVault(browserVaultStore()),
  machine: clientBase(),
  ...extra
})

/** The Mac's own page: its plain Remember stays until lane D retires the page (unlock-flow.ts). */
const directFlow = (): UnlockFlowDeps | null => {
  const { remoteUnlockBegin: begin, remoteUnlock: send } = cookrew()
  return begin && send ? flowFor({ begin, send }, { plainRemember: true }) : null
}

/** The id of the connect code this page holds: a remembered box is kept and used under it only. */
const codeIdOf = async (code: string): Promise<string | undefined> => {
  const bytes = decodeBase64Url(code)
  return bytes === null ? undefined : connectCodeId(new Uint8Array(bytes)).catch(() => undefined)
}

/** Remember is offered on the Mac's own page, and on the console only when the Mac can remember over this v2 session. */
export const rememberOffered = (ownPage: boolean, shown: { readonly rememberable: boolean } | null): boolean => ownPage || shown?.rememberable === true

type Way =
  | { readonly kind: 'opening' }
  | { readonly kind: 'ready'; readonly deps: UnlockFlowDeps }
  | { readonly kind: 'needs-code'; readonly stale: boolean; readonly changed?: boolean }
  | { readonly kind: 'failed'; readonly message: string }

/** How this device reaches the door. `attempt` asks again, after a new code. */
function useUnlockWay(attempt: number): Way {
  const [way, setWay] = useState<Way>({ kind: 'opening' })
  const [retry, setRetry] = useState(0)
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
    openSeal({ url: (path) => `${base}${path}`, code, fetchFn: sealFetchFor(base), pin: sealPinFor(codeKeyForBase(base)) })
      .then(async (opened) => {
        client = opened
        if (!alive) return opened.close()
        const codeId = await codeIdOf(code)
        if (!alive) return
        setWay({ kind: 'ready', deps: flowFor(sealedUnlockApi(opened, authHeaders, seated), codeId === undefined ? {} : { codeId }) })
      })
      .catch(async (failure: unknown) => {
        if (!alive) return
        // A machine on v2 names the code that replaced the held one; only that one is taken (seal-next-code.ts).
        // A machine never seen on v2 keeps the old rule: the waiting code is tried once.
        const codeKey = codeKeyForBase(base)
        const vouched = sealPinFor(codeKey).v2() ? await vouchedNextCode(window.localStorage, codeKey, code, failure) : null
        if (!alive) return
        const next = afterRefusal(failure, () => (sealPinFor(codeKey).v2() ? vouched : takeNextCode(window.localStorage, codeKey)))
        if (next.kind !== 'try') return setWay(next)
        authStore().saveConnectCode(next.code)
        setRetry((n) => n + 1)
      })
    return () => {
      alive = false
      client?.close()
    }
  }, [attempt, retry])
  return way
}

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure))

export type AfterRefusal =
  | { readonly kind: 'try'; readonly code: string }
  | { readonly kind: 'needs-code'; readonly stale: true; readonly changed: boolean }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * WHAT FOLLOWS A SESSION THAT DID NOT OPEN. The machine does not know the code
 * held, or proved that it replaced it: either way the code is out of date. One
 * that was handed since and waited beside it (pairing-scope.ts) is the
 * machine's new one if anything is: it takes its place and is tried. With none
 * waiting, the sheet asks for it. Scanning again is the way back in both
 * cases, so both have to end here: a "replaced" that only showed a sentence
 * left the scanned code waiting for ever. Anything else is said as it is, and
 * spends no waiting code.
 */
export function afterRefusal(failure: unknown, takeWaited: () => string | null): AfterRefusal {
  const why = failure instanceof SealRefusedError ? failure.why : null
  if (why !== 'code' && why !== 'replaced') return { kind: 'failed', message: messageOf(failure) }
  const waited = takeWaited()
  return waited !== null ? { kind: 'try', code: waited } : { kind: 'needs-code', stale: true, changed: why === 'replaced' }
}

function UnlockSheetBody(): React.JSX.Element {
  const [attempt, setAttempt] = useState(0)
  const way = useUnlockWay(attempt)
  const deps = way.kind === 'ready' ? way.deps : null
  const [shown, setShown] = useState<{ key: string; trust: KeyTrust; saved: boolean; rememberable: boolean; words: readonly string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)

  const prepare = useCallback(async (): Promise<void> => {
    if (!deps) return
    const prepared = await prepareUnlock(deps)
    if (prepared.kind === 'done') return closeUnlockSheet(true)
    if (prepared.kind === 'error') return setError(prepared.message)
    setShown({ key: prepared.key, trust: prepared.trust, saved: prepared.saved, rememberable: prepared.rememberable, words: await wordsOfKey(prepared.key) })
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
      if (result.kind === 'changed') return setShown({ key: result.key, trust: 'changed', saved: false, rememberable: false, words: await wordsOfKey(result.key) })
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

  const canRemember = rememberOffered(onTheMacsOwnPage(), shown)
  return (
    <UnlockSheetView
      needsCode={way.kind === 'needs-code'}
      stale={way.kind === 'needs-code' && way.stale}
      changed={way.kind === 'needs-code' && way.changed === true}
      canRemember={canRemember}
      onCode={useCode}
      onSetUp={
        cookrew().unlockGrantAsk
          ? () => {
              closeUnlockSheet(false)
              openUnlockGrantSheet()
            }
          : undefined
      }
      trust={shown?.trust ?? null}
      words={shown?.words ?? null}
      saved={shown?.saved ?? false}
      busy={busy || (way.kind !== 'needs-code' && shown === null && error === null && way.kind !== 'failed')}
      error={error ?? (way.kind === 'failed' ? way.message : null)}
      password={password}
      remember={remember && canRemember}
      onPassword={setPassword}
      onRemember={setRemember}
      onUnlock={() => void unlock()}
      onForget={() => {
        // What this device keeps goes, and a console gives the Mac its id back (unlock-flow.ts · forgetRemembered).
        if (deps) void forgetRemembered(deps).then(prepare)
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
