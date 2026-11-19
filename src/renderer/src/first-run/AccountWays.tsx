import { useState } from 'react'
import { ACCOUNT_COPY } from '../../../shared/account-guide-copy'
import { accountVia, defaultChoices, needsDefault, subscriptionLines } from '../../../shared/ai-account'
import type { RouteState } from '../../../shared/route'
import { openMagpieSettings } from '../routing/magpie-card'
import { MagpieSwitches, useMagpieSwitches } from '../routing/MagpieSwitches'
import type { LiveValues } from '../../../shared/launch-settings'
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
  /** The Magpie switches; absent = read them live (MagpieSwitches.tsx). */
  switches?: LiveValues
  /** Draw the two switches above the ways (off where a page already shows them). */
  showSwitches?: boolean
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

/** A bridge without the switches (the phone, a demo) shows every way, as before them. */
const SHOW_ALL: LiveValues = { magpie: true, magpieRemote: true }

export function AccountWays({ route, endpointActive, endpoint, onRun, running, onSetDefault, switches, showSwitches = true }: AccountWaysProps): React.JSX.Element {
  const [remoteProblem, setRemoteProblem] = useState<string | null>(null)
  const read = useMagpieSwitches().values
  const on = switches ?? read ?? SHOW_ALL
  const installed = route !== null && (route.status !== 'absent' || route.switchedOff === true)
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
      {showSwitches && <MagpieSwitches installed={installed} />}
      {magpie === 'offline' && route && (
        <Way title={ACCOUNT_COPY.STOPPED_MAGPIE}>{press(route.setup.serveLine, ACCOUNT_COPY.START_MAGPIE)}</Way>
      )}
      <Way title={ACCOUNT_COPY.SUBSCRIPTION} does={subscriptions.length > 0 ? ACCOUNT_COPY.SUBSCRIPTION_DOES : ACCOUNT_COPY.SUBSCRIPTION_NONE}>
        {subscriptions.map((s) => press(s.line, s.label))}
      </Way>
      {on.magpie && (
      <Way title={ACCOUNT_COPY.API_KEY} does={ACCOUNT_COPY.API_KEY_DOES}>
        {magpie === 'absent' || !route ? (
          needsMagpie()
        ) : (
          <button type="button" className="fr-fix" data-way="api-key" onClick={() => void openMagpieSettings().then(setRemoteProblem)}>
            {ACCOUNT_COPY.REMOTE_OPEN}
          </button>
        )}
      </Way>
      )}
      {on.magpie && on.magpieRemote && (
      // Sealed, no key typed anywhere: the press is in Your computers (routing/DevicesGuide.tsx).
      <Way title={ACCOUNT_COPY.REMOTE} does={ACCOUNT_COPY.REMOTE_DOES}>
        {magpie === 'absent' || !route ? needsMagpie() : <span data-way="remote-magpie" />}
      </Way>
      )}
      {on.magpie && remoteProblem && (
        <p className="fr-error" role="alert">
          {remoteProblem}
        </p>
      )}
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
