// THE UPDATE ROWS in ⋯: the switch, and what a found release needs next: the
// release page, a download under way, or a restart. The check lives on a packaged
// desktop, so a source build, the phone and a served page get no status and no rows.
import { useEffect, useState } from 'react'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { parseUpdateStatus, UPDATE_AUTO_NOTE, UPDATE_ROW_NOTE, type UpdateRelease, type UpdateStatus } from '../../shared/update-check'

interface UpdateRowsViewProps {
  status: UpdateStatus
  onToggle: () => void
  onOpen: (url: string) => void
  onRestart: () => void
}

function FoundRow({ release, status, onOpen, onRestart }: { release: UpdateRelease } & Omit<UpdateRowsViewProps, 'onToggle'>): React.JSX.Element {
  const { label, note, press } =
    status.install === 'ready'
      ? { label: `Restart to update to ${release.version}`, note: 'Installs it and starts Cookrew again.', press: onRestart }
      : status.install === 'downloading'
        ? { label: `Downloading Cookrew ${release.version}…`, note: 'A restart is offered here when it is done.', press: undefined }
        : { label: `Download Cookrew ${release.version}`, note: 'Opens the release page in your browser.', press: () => onOpen(release.url) }
  return (
    <button type="button" className="cr-more-item tall on" disabled={press === undefined} onClick={press}>
      <CrIcon name="arrow-down" />
      <span className="cr-more-text">
        <span className="cr-more-label">{label}</span>
        <span className="cr-more-note">{note}</span>
      </span>
    </button>
  )
}

export function UpdateRowsView({ status, onToggle, onOpen, onRestart }: UpdateRowsViewProps): React.JSX.Element {
  const { available, auto } = status
  const name = auto ? 'Automatic updates' : 'Check for updates'
  return (
    <>
      {available && <FoundRow release={available} status={status} onOpen={onOpen} onRestart={onRestart} />}
      <button type="button" className={`cr-more-item tall${status.on ? ' on' : ''}`} aria-pressed={status.on} onClick={onToggle}>
        <CrIcon name="arrow-up" />
        <span className="cr-more-text">
          <span className="cr-more-label">{`${name} ${status.on ? 'on' : 'off'}`}</span>
          <span className="cr-more-note">{auto ? UPDATE_AUTO_NOTE : UPDATE_ROW_NOTE}</span>
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
  const onRestart = (): void => {
    void cookrew()
      .restartToUpdate?.()
      .catch(() => undefined)
  }
  return <UpdateRowsView status={status} onToggle={onToggle} onOpen={onOpen} onRestart={onRestart} />
}
