import { useEffect, useState, useSyncExternalStore } from 'react'
import { cookrew } from '../api'
import { SHARE_COPY } from '../../../shared/account-guide-copy'
import { DEFAULT_DAILY_USD, type PendingKey, type SharedKey, type ShareWhere } from '../../../shared/share-devices'
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

/** One key a failed issue may have left behind: it stays until cleared, and can be cleared only once main allows it. */
function PendingRow({ pending, busy, onResolve, onClear }: { pending: PendingKey; busy: boolean; onResolve: () => void; onClear: () => void }): React.JSX.Element {
  return (
    <div className="cr-routing-bad" role="alert" data-pending={pending.name}>
      <b>{SHARE_COPY.PENDING_HEAD}</b>
      <p className="small">{SHARE_COPY.PENDING(pending.device, pending.at)}</p>
      {pending.revoked && pending.revoked.left > 0 && <p className="small">{SHARE_COPY.PENDING_LEFT(pending.revoked.left)}</p>}
      {pending.checked && pending.checked.live > 0 && <p className="small">{SHARE_COPY.PENDING_LIVE(pending.checked.live)}</p>}
      <span>
        <button type="button" className="cr-routing-btn" disabled={busy} onClick={onResolve}>
          {busy ? SHARE_COPY.PENDING_RESOLVING : SHARE_COPY.PENDING_RESOLVE}
        </button>{' '}
        <button type="button" className="cr-routing-btn" disabled={busy || !pending.clearable} onClick={onClear}>
          {SHARE_COPY.PENDING_CLEAR}
        </button>
      </span>
      <small>{SHARE_COPY.PENDING_CLEAR_NOTE}</small>
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
  pending = [],
  resolving = [],
  onIssue,
  onRevoke,
  onCheck,
  onDone,
  onResolve = () => {},
  onClear = () => {}
}: {
  keys: readonly SharedKey[]
  where: ShareWhere | null
  problem: string | null
  issued: Issued | null
  busy: boolean
  sharingEnabled?: boolean
  revoking?: readonly string[]
  pending?: readonly PendingKey[]
  resolving?: readonly string[]
  onIssue: (device: string, dailyUsd: number) => void
  onRevoke: (id: string) => void
  onCheck: () => void
  onDone: () => void
  onResolve?: (name: string) => void
  onClear?: (name: string) => void
}): React.JSX.Element {
  const [device, setDevice] = useState('')
  const [daily, setDaily] = useState(String(DEFAULT_DAILY_USD))
  return (
    <div className="cr-routing-share">
      <div className="cr-routing-seg">{SHARE_COPY.HEAD}</div>
      <p className="small">{SHARE_COPY.LEDE}</p>
      {pending.map((p) => (
        <PendingRow key={p.name} pending={p} busy={resolving.includes(p.name)} onResolve={() => onResolve(p.name)} onClear={() => onClear(p.name)} />
      ))}
      {!sharingEnabled && <p className="small">{SHARE_COPY.SWITCHED_OFF}</p>}
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
      ) : sharingEnabled ? (
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
      pending={state.pending}
      resolving={state.resolving}
      onResolve={(name) => void store.resolve(name)}
      onClear={(name) => void store.clear(name)}
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
