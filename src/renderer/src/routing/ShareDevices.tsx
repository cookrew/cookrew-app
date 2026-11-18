import { useEffect, useState, useSyncExternalStore } from 'react'
import { cookrew } from '../api'
import { SHARE_COPY } from '../../../shared/account-guide-copy'
import { DEFAULT_DAILY_USD, SHARE_ISSUANCE_AVAILABLE, type SharedKey, type ShareWhere } from '../../../shared/share-devices'
import { problemText, shareDevicesStoreFor, type Issued, type ShareDevicesStore } from './share-devices-store'

/**
 * SHARE WITH MY DEVICES: this computer's Magpie for the owner's other computers
 * (main/route/share-keys.ts). One key per device, a daily cap on each, revoked
 * here. The key arrives once, in the answer to "Make a key", and is held only
 * until Done: it is for the owner to copy to the other device. The state is
 * held in share-devices-store.ts, so closing the panel loses none of it.
 */

function IssuedKey({ issued, onDone }: { issued: Issued; onDone: () => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="cr-share-key" role="status">
      <b>{issued.device}</b>
      <code className="cr-share-secret">{issued.key}</code>
      <small>{SHARE_COPY.KEY_ONCE}</small>
      <span>
        <button type="button" className="cr-routing-btn primary" onClick={() => {
          void navigator.clipboard?.writeText(issued.key).then(() => setCopied(true)).catch(() => setCopied(false))
        }}>
          {copied ? SHARE_COPY.COPIED : SHARE_COPY.COPY}
        </button>{' '}
        <button type="button" className="cr-routing-btn" onClick={onDone}>{SHARE_COPY.DONE}</button>
      </span>
    </div>
  )
}

export function ShareDevicesView({
  keys,
  where,
  problem,
  issued,
  busy,
  sharingEnabled = true,
  revoking = [],
  onIssue,
  onRevoke,
  onCheck,
  onDone
}: {
  keys: readonly SharedKey[]
  where: ShareWhere | null
  problem: string | null
  issued: Issued | null
  busy: boolean
  sharingEnabled?: boolean
  revoking?: readonly string[]
  onIssue: (device: string, dailyUsd: number) => void
  onRevoke: (id: string) => void
  onCheck: () => void
  onDone: () => void
}): React.JSX.Element {
  const [device, setDevice] = useState('')
  const [daily, setDaily] = useState(String(DEFAULT_DAILY_USD))
  return (
    <div className="cr-routing-share">
      <div className="cr-routing-seg">{SHARE_COPY.HEAD}</div>
      <p className="small">{SHARE_COPY.LEDE}</p>
      {!SHARE_ISSUANCE_AVAILABLE && <p className="small">Creating device keys is temporarily unavailable. Existing keys can still be revoked.</p>}
      {!sharingEnabled && <p className="small">Existing device keys still work. Revoke a key to cut off that device.</p>}
      {where && !where.onNetwork && (
        <p className="cr-routing-bad">
          {SHARE_COPY.OFF_NETWORK}{' '}
          <button type="button" className="cr-routing-btn" onClick={onCheck}>
            {SHARE_COPY.CHECK}
          </button>
        </p>
      )}
      {where && (
        <p className="small">
          {SHARE_COPY.ADDRESSES}: {where.urls.length > 0 ? where.urls.map((url) => <code key={url}>{url} </code>) : SHARE_COPY.NO_ADDRESS}
        </p>
      )}
      {where && where.urls.length > 0 && <p className="small" data-note="plain-http">{SHARE_COPY.PLAIN}</p>}
      {problem && (
        <p className="cr-routing-bad" role="alert">
          {problem}
        </p>
      )}
      {issued ? (
        <IssuedKey key={issued.id} issued={issued} onDone={onDone} />
      ) : sharingEnabled && SHARE_ISSUANCE_AVAILABLE ? (
        <form
          className="cr-share-form"
          onSubmit={(e) => {
            e.preventDefault()
            onIssue(device, Number(daily))
          }}
        >
          <label>
            <span className="small">{SHARE_COPY.DEVICE}</span>
            <input name="device" value={device} placeholder={SHARE_COPY.DEVICE_HINT} spellCheck={false} autoComplete="off" onChange={(e) => setDevice(e.target.value)} />
          </label>
          <label>
            <span className="small">{SHARE_COPY.DAILY}</span>
            <input name="daily" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
          </label>
          <button type="submit" className="cr-routing-btn primary" disabled={busy}>
            {busy ? SHARE_COPY.ISSUING : SHARE_COPY.ISSUE}
          </button>
        </form>
      ) : null}
      {keys.length === 0 ? (
        <p className="small">{SHARE_COPY.NONE}</p>
      ) : (
        <ul className="cr-share-keys">
          {keys.map((k) => (
            <li key={k.id}>
              <b>{k.device}</b> <span className="small">{k.limit ?? ''}</span>{' '}
              <button type="button" className="cr-routing-btn" disabled={revoking.includes(k.id)} onClick={() => onRevoke(k.id)}>
                {SHARE_COPY.REVOKE}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The section bound to one store (share-devices-store.ts): its state outlives the panel closing. */
export function ShareDevicesBound({ store, sharingEnabled }: { store: ShareDevicesStore; sharingEnabled: boolean }): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => {
    void store.read()
  }, [store])
  return (
    <ShareDevicesView
      keys={state.keys}
      where={state.where}
      problem={problemText(state)}
      issued={state.issued}
      busy={state.issuing}
      sharingEnabled={sharingEnabled}
      revoking={state.revoking}
      onCheck={() => void store.read()}
      onDone={store.done}
      onIssue={(device, dailyUsd) => {
        if (sharingEnabled) void store.issue(device, dailyUsd)
      }}
      onRevoke={(id) => void store.revoke(id)}
    />
  )
}

/** Absent where the bridge has no share channels: the phone and an older desktop. */
export function ShareDevices({ sharingEnabled }: { sharingEnabled: boolean }): React.JSX.Element | null {
  const bridge = cookrew()
  if (typeof bridge.routeShareList !== 'function') return null
  return <ShareDevicesBound store={shareDevicesStoreFor(bridge)} sharingEnabled={sharingEnabled} />
}
