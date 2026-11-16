import { useState } from 'react'
import { ACCOUNT_COPY } from '../../../shared/account-guide-copy'
import { accountVia, defaultChoices, needsDefault, subscriptionLines } from '../../../shared/ai-account'
import type { RouteState } from '../../../shared/route'
import { keyLineFor } from '../../../shared/route-lines'
import { KEY_PRESETS } from '../../../shared/route-view'
import { RemoteMagpieForm } from '../routing/RemoteMagpieForm'
import { runningLabel, type SetupRunning } from '../routing/setup-line-state'
import type { RunOptions } from '../routing/use-setup-terminal'

/**
 * CONNECT AN AI ACCOUNT: the four ways in, one row each (shared/ai-account.ts).
 * The first run's tool check draws it, and so does the Routing panel while
 * nothing is connected. Every press is a line in the Setup terminal; a key is
 * pasted there by the person, never typed into a Cookrew field. Once Magpie has
 * models and no default, the one step left is picking it, right here.
 */

export interface AccountWaysProps {
  route: RouteState | null
  endpointActive: boolean
  /** The own-endpoint rows (AccessRows), drawn in their place. */
  endpoint?: React.ReactNode
  onRun: (line: string, options?: RunOptions) => void
  running: SetupRunning | null
  onSetDefault?: (model: string) => void
}

function Way({ title, does, stack = false, children }: { title: string; does?: string; stack?: boolean; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`fr-access-row fr-way${stack ? ' fr-way-stack' : ''}`}>
      <span className="fr-tool">
        <b>{title}</b>
        {does && <small>{does}</small>}
      </span>
      <span className="fr-way-act">{children}</span>
    </div>
  )
}

export function AccountWays({ route, endpointActive, endpoint, onRun, running, onSetDefault }: AccountWaysProps): React.JSX.Element {
  const [remoteOpen, setRemoteOpen] = useState(false)
  const via = accountVia({ route, endpoint: endpointActive })
  const held = running !== null
  const press = (line: string, label: string, options?: RunOptions): React.JSX.Element => (
    <button key={line} type="button" className="fr-fix" disabled={held} title={line} onClick={() => onRun(line, options)}>
      {runningLabel(running, line) ?? label}
    </button>
  )
  const magpie = route?.status ?? 'absent'
  const needsMagpie = (): React.JSX.Element =>
    magpie === 'absent' && route ? (
      <>
        <small className="fr-note">{ACCOUNT_COPY.NEEDS_MAGPIE}</small>
        {press(route.setup.installLine, ACCOUNT_COPY.INSTALL_MAGPIE)}
      </>
    ) : (
      <small className="fr-note">{ACCOUNT_COPY.NEEDS_MAGPIE}</small>
    )
  const subscriptions = subscriptionLines(route)
  return (
    <div className="fr-access fr-accounts" data-ready={via !== null}>
      <h2 className="fr-access-head">{ACCOUNT_COPY.HEAD}</h2>
      <p className="fr-why">{via === null ? ACCOUNT_COPY.LEDE : ACCOUNT_COPY.READY(via)}</p>
      {magpie === 'offline' && route && (
        <Way title={ACCOUNT_COPY.MAGPIE_STOPPED}>{press(route.setup.serveLine, ACCOUNT_COPY.START_MAGPIE)}</Way>
      )}
      <Way title={ACCOUNT_COPY.SUBSCRIPTION} does={subscriptions.length > 0 ? ACCOUNT_COPY.SUBSCRIPTION_DOES : ACCOUNT_COPY.SUBSCRIPTION_NONE}>
        {subscriptions.map((s) => press(s.line, s.label))}
      </Way>
      <Way title={ACCOUNT_COPY.API_KEY} does={ACCOUNT_COPY.API_KEY_DOES} stack={magpie !== 'absent'}>
        {magpie === 'absent' || !route
          ? needsMagpie()
          : KEY_PRESETS.map((preset) => {
              const line = keyLineFor(route.setup.addKeyLine, preset)
              return line === null ? null : press(line, preset, { enter: false })
            })}
      </Way>
      <Way title={ACCOUNT_COPY.REMOTE} does={ACCOUNT_COPY.REMOTE_DOES}>
        {magpie === 'absent' || !route ? (
          needsMagpie()
        ) : (
          <button type="button" className="fr-fix" aria-expanded={remoteOpen} onClick={() => setRemoteOpen((o) => !o)}>
            {ACCOUNT_COPY.OPEN}
          </button>
        )}
      </Way>
      {remoteOpen && magpie !== 'absent' && <RemoteMagpieForm onRun={onRun} onCancel={() => setRemoteOpen(false)} />}
      {endpoint !== undefined && (
        <div className="fr-way-endpoint">
          {endpoint}
        </div>
      )}
      {route && needsDefault(route) && onSetDefault && (
        <label className="fr-field fr-default">
          <span>{ACCOUNT_COPY.DEFAULT_HEAD}</span>
          <small>{ACCOUNT_COPY.DEFAULT_DOES}</small>
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value !== '') onSetDefault(e.target.value)
            }}
          >
            <option value="" disabled>
              {ACCOUNT_COPY.DEFAULT_PICK}
            </option>
            {defaultChoices(route.models).map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName === m.id ? m.id : `${m.displayName} · ${m.id}`}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}
