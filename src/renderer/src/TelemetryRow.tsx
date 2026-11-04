// THE USAGE-DATA ROW in ⋯. It says what is sent in the row itself, not in a
// tooltip: this is the one place a person can read the promise before pressing.
// The switch lives on this machine, so where the bridge has no such call (the
// phone, a served page) the row is simply not there.
import { useEffect, useState } from 'react'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { TELEMETRY_ROW_NOTE, type TelemetryStatus } from '../../shared/funnel-events'

interface TelemetryRowViewProps {
  status: TelemetryStatus
  onToggle: () => void
}

export function TelemetryRowView({ status, onToggle }: TelemetryRowViewProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`cr-more-item${status.on ? ' on' : ''}`}
      aria-pressed={status.on}
      disabled={status.locked}
      onClick={onToggle}
    >
      <CrIcon name="summary" />
      <span className="cr-more-text">
        <span className="cr-more-label">{status.on ? 'Usage data on' : 'Usage data off'}</span>
        <span className="cr-more-note">
          {status.locked ? 'Held off by COOKREW_TELEMETRY=0. ' : ''}
          {TELEMETRY_ROW_NOTE}
        </span>
      </span>
    </button>
  )
}

export function TelemetryRow(): React.JSX.Element | null {
  const [status, setStatus] = useState<TelemetryStatus | null>(null)

  useEffect(() => {
    let alive = true
    void cookrew()
      .telemetryStatus?.()
      .then((next) => alive && setStatus(next))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  if (status === null) return null
  const onToggle = (): void => {
    void cookrew()
      .setTelemetry?.(!status.on)
      .then(setStatus)
      .catch(() => undefined)
  }
  return <TelemetryRowView status={status} onToggle={onToggle} />
}
