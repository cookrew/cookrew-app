// THE UPDATE ROWS in ⋯: the check's switch, and a way to the download page when
// it found something. The check lives on a packaged desktop, so a source build,
// the phone and a served page get no status and no rows.
import { useEffect, useState } from 'react'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { parseUpdateStatus, UPDATE_ROW_NOTE, type UpdateStatus } from '../../shared/update-check'

interface UpdateRowsViewProps {
  status: UpdateStatus
  onToggle: () => void
  onOpen: (url: string) => void
}

export function UpdateRowsView({ status, onToggle, onOpen }: UpdateRowsViewProps): React.JSX.Element {
  const { available } = status
  return (
    <>
      {available && (
        <button type="button" className="cr-more-item tall on" onClick={() => onOpen(available.url)}>
          <CrIcon name="arrow-down" />
          <span className="cr-more-text">
            <span className="cr-more-label">Download Cookrew {available.version}</span>
            <span className="cr-more-note">Opens the release page in your browser.</span>
          </span>
        </button>
      )}
      <button type="button" className={`cr-more-item tall${status.on ? ' on' : ''}`} aria-pressed={status.on} onClick={onToggle}>
        <CrIcon name="arrow-up" />
        <span className="cr-more-text">
          <span className="cr-more-label">{status.on ? 'Check for updates on' : 'Check for updates off'}</span>
          <span className="cr-more-note">{UPDATE_ROW_NOTE}</span>
        </span>
      </button>
    </>
  )
}

/** Held by the menu's owner, not the open menu: the ⋯ button shows a found update too. */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    let alive = true
    const take = (raw: unknown): void => {
      if (alive) setStatus(parseUpdateStatus(raw))
    }
    void cookrew()
      .updateStatus?.()
      .then(take)
      .catch(() => undefined)
    const off = cookrew().onUpdateStatus?.(take)
    return () => {
      alive = false
      off?.()
    }
  }, [])

  return status
}

export function UpdateRows({ status }: { status: UpdateStatus }): React.JSX.Element {
  // The next status comes back through the same channel the hook listens on.
  const onToggle = (): void => {
    void cookrew()
      .setUpdateCheck?.(!status.on)
      .catch(() => undefined)
  }
  const onOpen = (url: string): void => {
    void cookrew()
      .openExternal?.(url)
      ?.catch(() => undefined)
  }
  return <UpdateRowsView status={status} onToggle={onToggle} onOpen={onOpen} />
}
