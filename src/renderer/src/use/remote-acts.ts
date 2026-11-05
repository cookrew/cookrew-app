import { useCallback, useEffect, useState } from 'react'
import { parseRemoteState, type RemoteAccess, type RemoteAction, type RemoteConfirm, type RemoteHostView, type RemoteState, type RemoteWhere } from '../../../shared/remote-access'
import { cookrew, isRemoteMode } from '../api'

/**
 * WHAT THE PANEL'S BUTTONS DO, FOR EVERY PLACE THAT DRAWS IT. Which side of the
 * glass the reader is on is a fact about this client: the Mac's own window is
 * here, anything else is away, a browser on the same Mac included.
 */

export const remoteWhere = (): RemoteWhere => (isRemoteMode() ? 'away' : 'here')

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const accessOf = (answer: RemoteAccess | { ok: false; error: string } | undefined): RemoteAccess | null => {
  if (!answer || !('state' in answer)) return null
  const state = parseRemoteState(answer.state)
  return state ? { ...answer, state } : null
}

interface Acts {
  readonly busy: boolean
  readonly note: string | null
  readonly confirm: RemoteConfirm | null
  act(action: RemoteAction): void
  answerConfirm(yes: boolean): void
}

/**
 * `onCheck` reads the state again; `onOpened` hears that a settings page opened,
 * for a place that should show `waiting` now; `onOther` takes the actions only
 * its place can do.
 */
export function useRemoteActs(options: { state: RemoteState | null; onCheck: () => Promise<void> | void; onOpened?: () => Promise<void> | void; onOther?: (action: RemoteAction) => void }): Acts {
  const { state, onCheck, onOpened, onOther } = options
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [pending, setPending] = useState<RemoteAction | null>(null)

  const run = useCallback(
    async (action: RemoteAction): Promise<void> => {
      setBusy(true)
      setNote(null)
      try {
        if (action.id === 'check-again') {
          await onCheck()
        } else if (action.id === 'restart') {
          const answer = await cookrew().remoteRestart?.()
          setNote(answer?.ok === false ? answer.error : 'Restarting Cookrew…')
        } else if (action.id === 'open-screen-settings' || action.id === 'open-accessibility-settings') {
          const answer = await cookrew().openScreenSettings?.(action.id === 'open-screen-settings' ? 'screen' : 'accessibility')
          const name = state?.build.settingsName ?? 'Cookrew'
          const opened = isRemoteMode() ? 'System Settings is open on the Mac for when you are there.' : `Turn on ${name} there, then Check again.`
          setNote(answer?.ok === false ? answer.error : opened)
          if (isRemoteMode()) await onOpened?.()
        } else {
          onOther?.(action)
        }
      } catch (failure) {
        setNote(messageOf(failure))
      } finally {
        setBusy(false)
      }
    },
    [onCheck, onOpened, onOther, state]
  )

  return {
    busy,
    note,
    confirm: pending?.confirm ?? null,
    act: (action) => (action.confirm ? setPending(action) : void run(action)),
    answerConfirm: (yes) => {
      const action = pending
      setPending(null)
      if (yes && action) void run(action)
    }
  }
}

/** Where this machine stands, read when asked: each read is a process on the Mac. */
export function useRemoteAccess(active: boolean): { access: RemoteAccess | null; read: () => Promise<void> } {
  const [access, setAccess] = useState<RemoteAccess | null>(null)
  const read = useCallback(async (): Promise<void> => {
    const answer = await cookrew().remoteAccess?.().catch(() => undefined)
    setAccess(accessOf(answer))
  }, [])
  useEffect(() => {
    if (active) void read()
  }, [active, read])
  return { access, read }
}

/** Who is on this machine right now: the Mac's own window only, which is the only place it is asked. */
export function useRemoteHost(): RemoteHostView | null {
  const [view, setView] = useState<RemoteHostView | null>(null)
  useEffect(() => {
    const api = cookrew()
    let live = true
    void api.remoteHost?.().then((first) => {
      if (live && first && 'rows' in first) setView(first)
    })
    const off = api.onRemoteHost?.(setView)
    return () => {
      live = false
      off?.()
    }
  }, [])
  return view
}
